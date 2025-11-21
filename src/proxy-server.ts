import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as zlib from 'zlib';
import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { FileLogger } from './file-logger';

export interface ProxyServerOptions {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  useHttps?: boolean;
  localHttps?: boolean;
  logBody?: boolean;
  mergeSse?: boolean;
  debug?: boolean;
  chatMode?: boolean;
  verbose?: boolean;
  // Multi-user options
  multiUser?: boolean;
  bindAddress?: string;
  logsDir?: string;
}

interface SseEvent {
  event?: string;
  data?: string;
  id?: string;
}

interface SseMessage {
  requestId: string;
  events: SseEvent[];
  mergedContent: string;
  username?: string;
}

interface RequestContext {
  requestId: string;
  username: string;
  startTime: number;
}

interface ParsedPath {
  username: string | null;
  actualPath: string;
}

export class ProxyServer {
  private server: http.Server | https.Server;
  private options: ProxyServerOptions;
  private sseMessages: Map<string, SseMessage> = new Map();
  private fileLogger: FileLogger | null = null;

  constructor(options: ProxyServerOptions) {
    this.options = options;

    // Initialize multi-user components if enabled
    if (options.multiUser) {
      this.fileLogger = new FileLogger(options.logsDir);
    }

    // Configure marked with terminal renderer
    marked.setOptions({
      renderer: new TerminalRenderer({
        code: chalk.cyan,
        blockquote: chalk.gray,
        html: chalk.gray,
        heading: chalk.green.bold,
        firstHeading: chalk.green.bold.underline,
        hr: chalk.gray,
        listitem: chalk.white,
        paragraph: chalk.white,
        strong: chalk.bold,
        em: chalk.italic,
        codespan: chalk.cyan,
        del: chalk.strikethrough,
        link: chalk.blue.underline,
        href: chalk.blue.underline
      }) as any
    });

    if (options.localHttps) {
      this.server = https.createServer(this.handleRequest.bind(this));
    } else {
      this.server = http.createServer(this.handleRequest.bind(this));
    }

    this.server.on('connect', this.handleConnect.bind(this));
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const bindAddress = this.options.bindAddress || '127.0.0.1';
      this.server.listen(this.options.localPort, bindAddress, () => {
        resolve();
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  stop(): void {
    this.server.close();
    if (this.fileLogger) {
      this.fileLogger.close();
    }
  }

  /**
   * Parse URL path to extract username and actual API path
   * Format: /user/<username>/v1/messages -> { username: "username", actualPath: "/v1/messages" }
   */
  private parseUserPath(url: string | undefined): ParsedPath {
    if (!url) {
      return { username: null, actualPath: '/' };
    }

    // Match /user/<username>/<rest of path>
    const match = url.match(/^\/user\/([^\/]+)(\/.*)?$/);
    if (match) {
      const username = match[1];
      const actualPath = match[2] || '/';
      return { username, actualPath };
    }

    return { username: null, actualPath: url };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Global health check endpoint (no user required)
    if (req.url === '/health' || req.url === '/_health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime()
      }));
      return;
    }

    const startTime = Date.now();
    const requestId = Math.random().toString(36).substring(2, 11);

    // Parse user from URL path in multi-user mode
    let username = 'anonymous';
    let actualPath = req.url || '/';

    if (this.options.multiUser) {
      const parsed = this.parseUserPath(req.url);

      if (!parsed.username) {
        // No username in path - reject request
        console.log(chalk.red(`[${requestId}] ❌ Missing user in URL path. Use /user/<username>/v1/messages`));
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: URL must include user path. Format: /user/<username>/v1/messages');
        return;
      }

      username = parsed.username;
      actualPath = parsed.actualPath;

      // User-specific health check endpoint
      if (actualPath === '/v1/health' || actualPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          user: username,
          timestamp: Date.now(),
          uptime: process.uptime()
        }));
        return;
      }

      if (this.options.debug) {
        console.log(chalk.magenta(`[${requestId}] 🔍 User: ${username}, Path: ${actualPath}`));
      }
    }

    const context: RequestContext = {
      requestId,
      username,
      startTime
    };

    let requestBody = Buffer.alloc(0);

    if (this.options.chatMode && this.options.debug) {
      this.debugLog(context, `handleRequest called for ${req.method} ${actualPath}`);
    }

    this.logRequest(context, req, actualPath);

    const options: http.RequestOptions | https.RequestOptions = {
      hostname: this.options.remoteHost,
      port: this.options.remotePort,
      path: actualPath,  // Use actual path without /user/<username>
      method: req.method,
      headers: { ...req.headers }
    };

    // Remove proxy-specific headers before forwarding
    if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
      delete (options.headers as any).host;
      delete (options.headers as any)['proxy-authorization'];
      (options.headers as any).host = `${this.options.remoteHost}:${this.options.remotePort}`;
    }

    const proxyReq = this.options.useHttps
      ? https.request(options, (proxyRes) => this.handleResponse(context, proxyRes, res, req.headers))
      : http.request(options, (proxyRes) => this.handleResponse(context, proxyRes, res, req.headers));

    proxyReq.on('error', (error) => {
      this.errorLog(context, 'Proxy request error:', error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy Error');
      }
    });

    req.on('data', (chunk) => {
      if (this.options.logBody || this.options.chatMode) {
        requestBody = Buffer.concat([requestBody, chunk]);
      }
      proxyReq.write(chunk);
    });

    req.on('end', () => {
      if (this.options.chatMode && this.options.debug) {
        this.debugLog(context, `Request ended, body length: ${requestBody.length}`);
      }

      if ((this.options.logBody || this.options.chatMode) && requestBody.length > 0) {
        this.logRequestBody(context, requestBody, req.headers);
      }
      proxyReq.end();
    });

    req.on('error', (error) => {
      this.errorLog(context, 'Client request error:', error.message);
      proxyReq.destroy();
    });
  }

  private handleResponse(
    context: RequestContext,
    proxyRes: http.IncomingMessage,
    res: http.ServerResponse,
    _reqHeaders: http.IncomingHttpHeaders
  ): void {
    const duration = Date.now() - context.startTime;
    let responseBody = Buffer.alloc(0);

    this.logResponse(context, proxyRes, duration);

    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

    proxyRes.on('data', (chunk) => {
      if (this.options.logBody || this.options.chatMode) {
        responseBody = Buffer.concat([responseBody, chunk]);
      }
      res.write(chunk);
    });

    proxyRes.on('end', () => {
      if (this.options.chatMode && this.options.debug) {
        this.debugLog(context, `Response ended, body length: ${responseBody.length}`);
      }

      if ((this.options.logBody || this.options.chatMode) && responseBody.length > 0) {
        this.logResponseBody(context, responseBody, proxyRes.headers);
      }
      res.end();
    });

    proxyRes.on('error', (error) => {
      this.errorLog(context, 'Proxy response error:', error.message);
      if (!res.writableEnded) {
        res.end();
      }
    });
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const requestId = Math.random().toString(36).substring(2, 11);
    const context: RequestContext = {
      requestId,
      username: 'tunnel',
      startTime: Date.now()
    };

    console.log(chalk.magenta(`[${requestId}] 🔒 CONNECT ${req.url}`));

    const { hostname, port } = this.parseConnectUrl(req.url || '');

    const serverSocket = net.createConnection({
      host: hostname,
      port: parseInt(port)
    }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);

      const duration = Date.now() - context.startTime;
      console.log(chalk.green(`[${requestId}] ✅ CONNECT established (${duration}ms)`));
    });

    serverSocket.on('error', (error) => {
      this.errorLog(context, 'CONNECT error:', error.message);
      clientSocket.end();
    });

    clientSocket.on('error', (error) => {
      this.errorLog(context, 'Client socket error:', error.message);
      serverSocket.end();
    });
  }

  private parseConnectUrl(connectUrl: string): { hostname: string; port: string } {
    const parts = connectUrl.split(':');
    return {
      hostname: parts[0],
      port: parts[1] || '443'
    };
  }

  private formatPrefix(context: RequestContext): string {
    if (this.options.multiUser) {
      return `[${context.requestId}:${context.username}]`;
    }
    return `[${context.requestId}]`;
  }

  private debugLog(context: RequestContext, message: string): void {
    console.log(chalk.magenta(`${this.formatPrefix(context)} 🔍 DEBUG: ${message}`));
  }

  private errorLog(context: RequestContext, label: string, message: string): void {
    console.error(chalk.red(`${this.formatPrefix(context)} ❌ ${label}`), message);
  }

  private logRequest(context: RequestContext, req: http.IncomingMessage, actualPath?: string): void {
    if (this.options.chatMode && !this.options.logBody) {
      return;
    }

    const prefix = this.formatPrefix(context);
    const timestamp = new Date().toISOString();
    const method = req.method?.toUpperCase() || 'UNKNOWN';
    const url = actualPath || req.url || '/';
    const userAgent = req.headers['user-agent'] || 'Unknown';

    console.log(chalk.cyan(`${prefix} 📤 ${timestamp}`));
    console.log(chalk.blue(`${prefix} ${method} ${url}`));
    console.log(chalk.gray(`${prefix} User-Agent: ${userAgent}`));

    if (req.headers['content-length']) {
      console.log(chalk.gray(`${prefix} Content-Length: ${req.headers['content-length']}`));
    }

    if (req.headers['content-type']) {
      console.log(chalk.gray(`${prefix} Content-Type: ${req.headers['content-type']}`));
    }

    // File logging
    if (this.fileLogger && this.options.multiUser) {
      this.fileLogger.logRequest(
        context.username,
        context.requestId,
        method,
        url
      );
    }
  }

  private logResponse(context: RequestContext, proxyRes: http.IncomingMessage, duration: number): void {
    if (this.options.chatMode && !this.options.logBody) {
      return;
    }

    const prefix = this.formatPrefix(context);
    const statusCode = proxyRes.statusCode || 0;
    const statusColor = statusCode >= 400 ? chalk.red : statusCode >= 300 ? chalk.yellow : chalk.green;

    console.log(chalk.cyan(`${prefix} 📥 Response`));
    console.log(statusColor(`${prefix} ${statusCode} ${proxyRes.statusMessage || ''} (${duration}ms)`));

    if (proxyRes.headers['content-length']) {
      console.log(chalk.gray(`${prefix} Content-Length: ${proxyRes.headers['content-length']}`));
    }

    if (proxyRes.headers['content-type']) {
      console.log(chalk.gray(`${prefix} Content-Type: ${proxyRes.headers['content-type']}`));
    }

    console.log(chalk.gray('─'.repeat(60)));

    // File logging
    if (this.fileLogger && this.options.multiUser) {
      this.fileLogger.logResponse(
        context.username,
        context.requestId,
        statusCode,
        duration
      );
    }
  }

  private logRequestBody(context: RequestContext, body: Buffer, headers?: http.IncomingHttpHeaders): void {
    const contentEncoding = headers?.['content-encoding'] as string;

    if (this.options.chatMode) {
      if (this.options.debug) {
        this.debugLog(context, `logRequestBody called with ${body.length} bytes`);
      }
      const fullBodyStr = this.getFullBody(body, contentEncoding);
      this.extractChatMessage(context, fullBodyStr, 'user');
    }

    const bodyStr = this.formatBody(body, contentEncoding);

    if (this.options.logBody || this.options.chatMode) {
      if (this.options.chatMode) {
        this.formatCompactRequest(context, bodyStr);
      } else {
        const prefix = this.formatPrefix(context);
        console.log(chalk.cyan(`${prefix} 📤 Request Body:`));
        console.log(chalk.gray(bodyStr));
      }
    }
  }

  private logResponseBody(context: RequestContext, body: Buffer, headers?: http.IncomingHttpHeaders): void {
    const contentType = headers?.['content-type'] as string;
    const contentEncoding = headers?.['content-encoding'] as string;

    if ((this.options.mergeSse || this.options.chatMode) && contentType?.includes('text/event-stream')) {
      this.processSseStream(context, body);
      return;
    }

    if (this.options.chatMode) {
      if (this.options.debug) {
        this.debugLog(context, `logResponseBody called with ${body.length} bytes, content-type: ${contentType}`);
      }
      const fullBodyStr = this.getFullBody(body, contentEncoding);
      this.extractChatMessage(context, fullBodyStr, 'assistant');
    }

    const bodyStr = this.formatBody(body, contentEncoding);

    if (this.options.logBody || this.options.chatMode) {
      if (this.options.chatMode) {
        this.formatCompactResponse(context, bodyStr);
      } else {
        const prefix = this.formatPrefix(context);
        console.log(chalk.cyan(`${prefix} 📥 Response Body:`));
        console.log(chalk.gray(bodyStr));
        console.log(chalk.gray('─'.repeat(60)));
      }
    }
  }

  private getFullBody(body: Buffer, contentEncoding?: string): string {
    try {
      let decompressedBody = body;
      if (contentEncoding) {
        try {
          switch (contentEncoding.toLowerCase()) {
            case 'gzip':
              decompressedBody = zlib.gunzipSync(body);
              break;
            case 'deflate':
              decompressedBody = zlib.inflateSync(body);
              break;
            case 'br':
              decompressedBody = zlib.brotliDecompressSync(body);
              break;
          }
        } catch {
          return '';
        }
      }

      if (this.isBinaryData(decompressedBody)) {
        return '';
      }

      return decompressedBody.toString('utf8');
    } catch {
      return '';
    }
  }

  private formatBody(body: Buffer, contentEncoding?: string): string {
    const maxLength = 1000;
    let bodyStr: string;

    try {
      let decompressedBody = body;
      if (contentEncoding) {
        try {
          switch (contentEncoding.toLowerCase()) {
            case 'gzip':
              decompressedBody = zlib.gunzipSync(body);
              break;
            case 'deflate':
              decompressedBody = zlib.inflateSync(body);
              break;
            case 'br':
              decompressedBody = zlib.brotliDecompressSync(body);
              break;
          }
        } catch {
          return `<Compressed data (${contentEncoding}): ${body.length} bytes - decompression failed>`;
        }
      }

      if (this.isBinaryData(decompressedBody)) {
        return `<Binary data: ${body.length} bytes${contentEncoding ? ` (${contentEncoding})` : ''}>`;
      }

      bodyStr = decompressedBody.toString('utf8');

      if (this.isJsonContent(bodyStr)) {
        try {
          const parsed = JSON.parse(bodyStr);
          bodyStr = JSON.stringify(parsed, null, 2);
        } catch {
          // Keep original if JSON parsing fails
        }
      }
    } catch {
      return `<Binary data: ${body.length} bytes${contentEncoding ? ` (${contentEncoding})` : ''}>`;
    }

    if (bodyStr.length > maxLength) {
      bodyStr = bodyStr.substring(0, maxLength) + '\n... (truncated)';
    }

    return bodyStr;
  }

  private isBinaryData(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, Math.min(512, buffer.length));
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) {
        return true;
      }
    }
    return false;
  }

  private isJsonContent(str: string): boolean {
    const trimmed = str.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
           (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  private containsMarkdown(text: string): boolean {
    const markdownPatterns = [
      /^#{1,6}\s/m,
      /\*\*[^*]+\*\*/,
      /\*[^*]+\*/,
      /\[([^\]]+)\]\([^)]+\)/,
      /^```[\s\S]*?```$/m,
      /`[^`]+`/,
      /^[-*+]\s/m,
      /^\d+\.\s/m,
      /^>\s/m,
      /!\[([^\]]*)\]\([^)]+\)/
    ];

    return markdownPatterns.some(pattern => pattern.test(text));
  }

  private renderMarkdown(text: string): string {
    try {
      if (this.containsMarkdown(text)) {
        if (this.options.debug) {
          console.log(chalk.magenta('🔍 DEBUG: Rendering markdown for text:', text.substring(0, 50) + '...'));
        }
        const rendered = marked.parse(text) as string;
        if (this.options.debug) {
          console.log(chalk.magenta('🔍 DEBUG: Rendered result:', rendered.substring(0, 50) + '...'));
        }
        return rendered;
      }
    } catch (error) {
      if (this.options.debug) {
        console.log(chalk.magenta('🔍 DEBUG: Markdown rendering failed:', error));
      }
    }
    return text;
  }

  private processSseStream(context: RequestContext, body: Buffer): void {
    const bodyStr = body.toString('utf8');
    const events = this.parseSseEvents(bodyStr);

    if (this.options.debug) {
      this.debugLog(context, `Processing ${body.length} bytes, found ${events.length} events`);
    }

    let sseMessage = this.sseMessages.get(context.requestId);
    if (!sseMessage) {
      sseMessage = {
        requestId: context.requestId,
        events: [],
        mergedContent: '',
        username: context.username
      };
      this.sseMessages.set(context.requestId, sseMessage);

      if (!this.options.chatMode) {
        const prefix = this.formatPrefix(context);
        console.log(chalk.cyan(`${prefix} 📥 SSE Stream Started:`));
      } else {
        const userPrefix = this.options.multiUser ? chalk.gray(`[${context.username}] `) : '';
        process.stdout.write(userPrefix + chalk.blue('🤖 '));
      }
    }

    sseMessage.events.push(...events);

    const eventTypes = events.map(e => e.event).filter(Boolean);
    if (this.options.debug && eventTypes.length > 0) {
      this.debugLog(context, `Event types: ${eventTypes.join(', ')}`);
    }

    const textDeltas = events
      .filter(event => event.event === 'content_block_delta')
      .map(event => {
        try {
          const data = JSON.parse(event.data || '{}');
          if (this.options.debug) {
            this.debugLog(context, `Delta data: ${JSON.stringify(data)}`);
          }
          const text = data.delta?.text || '';
          if (this.options.debug) {
            this.debugLog(context, `Extracted text: "${text}"`);
          }
          return text;
        } catch (error) {
          if (this.options.debug) {
            this.debugLog(context, `JSON parse error: ${error}`);
          }
          return '';
        }
      })
      .filter(text => text.length > 0);

    if (this.options.debug) {
      this.debugLog(context, `Found ${textDeltas.length} text deltas: ${JSON.stringify(textDeltas)}`);
    }

    if (textDeltas.length > 0) {
      const newText = textDeltas.join('');
      sseMessage.mergedContent += newText;

      if (!this.options.chatMode) {
        const prefix = this.formatPrefix(context);
        console.log(chalk.gray(`${prefix} 📝 +${newText}`));
      }
    }

    const hasMessageStop = events.some(event => event.event === 'message_stop');
    const hasContentBlockStop = events.some(event => event.event === 'content_block_stop');
    const hasMessageDelta = events.some(event => event.event === 'message_delta' && event.data?.includes('stop_reason'));

    if (this.options.debug) {
      this.debugLog(context, `Stream end check - message_stop: ${hasMessageStop}, content_block_stop: ${hasContentBlockStop}, message_delta: ${hasMessageDelta}`);
    }

    if (hasMessageStop || hasContentBlockStop || hasMessageDelta) {
      if (this.options.chatMode) {
        if (sseMessage.mergedContent) {
          const userPrefix = this.options.multiUser ? chalk.gray(`[${context.username}] `) : '';
          const rendered = this.renderMarkdown(sseMessage.mergedContent);
          console.log(userPrefix + chalk.blue('🤖 ') + rendered.trim());

          // File logging for chat
          if (this.fileLogger && this.options.multiUser) {
            this.fileLogger.logChatMessage(
              context.username,
              context.requestId,
              'assistant',
              sseMessage.mergedContent
            );
          }
        }
      } else {
        const prefix = this.formatPrefix(context);
        console.log(chalk.cyan(`${prefix} 📥 SSE Complete Message:`));
        const rendered = this.renderMarkdown(sseMessage.mergedContent || '<empty message>');
        console.log(chalk.green(rendered));
        console.log(chalk.gray('─'.repeat(60)));
      }
      this.sseMessages.delete(context.requestId);
    }
  }

  private parseSseEvents(sseData: string): SseEvent[] {
    const events: SseEvent[] = [];
    const lines = sseData.split('\n');
    let currentEvent: SseEvent = {};

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine === '') {
        if (Object.keys(currentEvent).length > 0) {
          events.push(currentEvent);
          currentEvent = {};
        }
      } else if (trimmedLine.startsWith('event:')) {
        currentEvent.event = trimmedLine.substring(6).trim();
      } else if (trimmedLine.startsWith('data:')) {
        const data = trimmedLine.substring(5).trim();
        currentEvent.data = (currentEvent.data || '') + data;
      } else if (trimmedLine.startsWith('id:')) {
        currentEvent.id = trimmedLine.substring(3).trim();
      }
    }

    if (Object.keys(currentEvent).length > 0) {
      events.push(currentEvent);
    }

    return events;
  }

  private formatCompactRequest(context: RequestContext, bodyStr: string): void {
    const prefix = this.formatPrefix(context);
    try {
      const data = JSON.parse(bodyStr);

      if (data.system && Array.isArray(data.system)) {
        data.system.forEach((s: any) => {
          if (s.text) {
            console.log(chalk.yellow(`${prefix}   📋 System:`));
            console.log(chalk.gray(`${prefix}   ${s.text}`));
          }
        });
      }

      console.log(chalk.gray(`${prefix}   📦 Request: ${bodyStr.length} bytes`));

      if (this.options.debug) {
        if (data.messages && Array.isArray(data.messages)) {
          data.messages.forEach((msg: any, idx: number) => {
            if (Array.isArray(msg.content)) {
              msg.content.forEach((item: any) => {
                if (item.type === 'text' && item.text && item.text.length > 1000) {
                  this.debugLog(context, `Message[${idx}] contains ${item.text.length} chars`);
                }
              });
            }
          });
        }
      }
    } catch {
      // Not JSON
    }
  }

  private formatCompactResponse(_context: RequestContext, _bodyStr: string): void {
    // In chat mode, we only care about the prompts/content, not metadata
  }

  private extractChatMessage(context: RequestContext, bodyStr: string, role: 'user' | 'assistant'): void {
    if (this.options.debug) {
      this.debugLog(context, `Extracting ${role} message from ${bodyStr.length} chars`);
    }

    const prefix = this.formatPrefix(context);
    const userPrefix = this.options.multiUser ? chalk.gray(`[${context.username}] `) : '';

    try {
      const data = JSON.parse(bodyStr);
      if (this.options.debug) {
        this.debugLog(context, `Parsed JSON for ${role}: ${JSON.stringify(data, null, 2).substring(0, 200)}`);
      }

      if (role === 'user' && data.messages && Array.isArray(data.messages)) {
        if (this.options.debug) {
          this.debugLog(context, `Found ${data.messages.length} messages`);
        }

        data.messages.forEach((message: any, idx: number) => {
          if (this.options.debug && idx === data.messages.length - 1) {
            this.debugLog(context, `Message[${idx}]: ${JSON.stringify(message).substring(0, 200)}`);
          }

          if (message.role === 'user') {
            console.log('');

            if (typeof message.content === 'string') {
              const rendered = this.renderMarkdown(message.content);
              console.log(userPrefix + chalk.green('👤 ') + rendered);

              // File logging
              if (this.fileLogger && this.options.multiUser) {
                this.fileLogger.logChatMessage(context.username, context.requestId, 'user', message.content);
              }
            } else if (Array.isArray(message.content)) {
              message.content.forEach((item: any) => {
                if (item.type === 'text' && item.text) {
                  if (item.text.includes('<system-reminder>')) {
                    const reminders = item.text.match(/<system-reminder>([\s\S]*?)<\/system-reminder>/g);
                    if (reminders) {
                      reminders.forEach((reminder: string) => {
                        const content = reminder.replace(/<\/?system-reminder>/g, '').trim();
                        console.log(userPrefix + chalk.yellow('  📋 System Reminder:'));
                        if (this.options.verbose) {
                          console.log(chalk.gray('  ' + content));
                        } else {
                          console.log(chalk.gray('  ' + content.substring(0, 200) + (content.length > 200 ? '...' : '')));
                        }
                      });
                    }

                    const userPart = item.text.split('</system-reminder>').pop()?.trim();
                    if (userPart && userPart.length > 0) {
                      const rendered = this.renderMarkdown(userPart);
                      console.log(userPrefix + chalk.green('👤 ') + rendered);

                      if (this.fileLogger && this.options.multiUser) {
                        this.fileLogger.logChatMessage(context.username, context.requestId, 'user', userPart);
                      }
                    }
                  } else if (item.text.includes('Contents of') && item.text.includes('```')) {
                    const fileMatch = item.text.match(/Contents of ([^:]+):/);
                    if (fileMatch) {
                      console.log(userPrefix + chalk.cyan(`  📄 File: ${fileMatch[1]}`));
                      if (this.options.verbose) {
                        console.log(chalk.gray('  ' + item.text));
                      } else {
                        console.log(chalk.gray(`  [${item.text.length} chars of file content]`));
                      }
                    }
                  } else {
                    const rendered = this.renderMarkdown(item.text);
                    console.log(userPrefix + chalk.green('👤 ') + rendered);

                    if (this.fileLogger && this.options.multiUser) {
                      this.fileLogger.logChatMessage(context.username, context.requestId, 'user', item.text);
                    }
                  }
                } else if (item.type === 'tool_result' && item.content) {
                  console.log(userPrefix + chalk.cyan('  🔧 Tool Result:'));
                  if (item.content.match(/^\s*\d+→/m)) {
                    const lines = item.content.split('\n');
                    console.log(chalk.gray(`  [${lines.length} lines of file content]`));
                    if (this.options.verbose) {
                      console.log(chalk.gray('  ' + lines.join('\n  ')));
                    } else {
                      console.log(chalk.gray('  ' + lines.slice(0, 5).join('\n  ')));
                      if (lines.length > 5) {
                        console.log(chalk.gray('  ...'));
                      }
                    }
                  } else {
                    if (this.options.verbose) {
                      console.log(chalk.gray('  ' + item.content));
                    } else {
                      console.log(chalk.gray('  ' + item.content.substring(0, 200) + (item.content.length > 200 ? '...' : '')));
                    }
                  }
                }
              });
            }
          } else if (message.role === 'assistant' && idx < data.messages.length - 1) {
            const content = typeof message.content === 'string'
              ? message.content
              : message.content?.[0]?.text || '';
            if (content) {
              const rendered = this.renderMarkdown(content);
              if (this.options.verbose) {
                console.log(userPrefix + chalk.blue('🤖 ') + chalk.gray('[previous] ') + rendered);
              } else {
                const truncated = content.substring(0, 100) + '...';
                const renderedTruncated = this.renderMarkdown(truncated);
                console.log(userPrefix + chalk.blue('🤖 ') + chalk.gray('[previous] ') + renderedTruncated);
              }
            }
          }
        });
      } else if (role === 'assistant' && data.content && Array.isArray(data.content)) {
        if (this.options.debug) {
          this.debugLog(context, `Assistant response with ${data.content.length} content items`);
        }

        const textContent = data.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('');

        if (this.options.debug) {
          this.debugLog(context, `Assistant text content: "${textContent}"`);
        }

        if (textContent.trim()) {
          const rendered = this.renderMarkdown(textContent);
          console.log(userPrefix + chalk.blue('🤖 ') + rendered);

          if (this.fileLogger && this.options.multiUser) {
            this.fileLogger.logChatMessage(context.username, context.requestId, 'assistant', textContent);
          }
        }
      } else {
        if (this.options.debug) {
          this.debugLog(context, `No matching pattern for ${role}. Data keys: ${Object.keys(data)}`);
        }
      }
    } catch (error) {
      if (this.options.debug) {
        console.log(chalk.red(`${prefix} 🔍 DEBUG: JSON parse error for ${role}:`, error));
        console.log(chalk.red(`${prefix} 🔍 DEBUG: Raw body:`, bodyStr.substring(0, 200)));
      }
    }
  }
}
