import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
  timestamp: string;
  requestId: string;
  username: string;
  type: 'request' | 'response' | 'chat';
  method?: string;
  url?: string;
  statusCode?: number;
  duration?: number;
  body?: string;
  role?: 'user' | 'assistant';
  content?: string;
}

export class FileLogger {
  private baseDir: string;
  private streams: Map<string, fs.WriteStream> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(process.cwd(), 'logs');
    this.ensureDirectory(this.baseDir);
  }

  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private getUserLogDir(username: string): string {
    const userDir = path.join(this.baseDir, username);
    this.ensureDirectory(userDir);
    return userDir;
  }

  private getDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  private getLogFilePath(username: string, type: 'raw' | 'chat'): string {
    const userDir = this.getUserLogDir(username);
    const date = this.getDateString();
    return path.join(userDir, `${date}-${type}.jsonl`);
  }

  private getOrCreateStream(filePath: string): fs.WriteStream {
    let stream = this.streams.get(filePath);
    if (!stream || stream.destroyed) {
      stream = fs.createWriteStream(filePath, { flags: 'a' });
      this.streams.set(filePath, stream);
    }
    return stream;
  }

  log(username: string, entry: LogEntry): void {
    const logPath = this.getLogFilePath(username, 'raw');
    const stream = this.getOrCreateStream(logPath);
    stream.write(JSON.stringify(entry) + '\n');
  }

  logChat(username: string, entry: LogEntry): void {
    const logPath = this.getLogFilePath(username, 'chat');
    const stream = this.getOrCreateStream(logPath);
    stream.write(JSON.stringify(entry) + '\n');
  }

  logRequest(
    username: string,
    requestId: string,
    method: string,
    url: string,
    body?: string
  ): void {
    this.log(username, {
      timestamp: new Date().toISOString(),
      requestId,
      username,
      type: 'request',
      method,
      url,
      body
    });
  }

  logResponse(
    username: string,
    requestId: string,
    statusCode: number,
    duration: number,
    body?: string
  ): void {
    this.log(username, {
      timestamp: new Date().toISOString(),
      requestId,
      username,
      type: 'response',
      statusCode,
      duration,
      body
    });
  }

  logChatMessage(
    username: string,
    requestId: string,
    role: 'user' | 'assistant',
    content: string
  ): void {
    this.logChat(username, {
      timestamp: new Date().toISOString(),
      requestId,
      username,
      type: 'chat',
      role,
      content
    });
  }

  close(): void {
    for (const stream of this.streams.values()) {
      stream.end();
    }
    this.streams.clear();
  }

  // Get log files for a user
  getUserLogFiles(username: string): string[] {
    const userDir = this.getUserLogDir(username);
    try {
      return fs.readdirSync(userDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(userDir, f));
    } catch {
      return [];
    }
  }

  // Read log entries from a file
  readLogFile(filePath: string): LogEntry[] {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
