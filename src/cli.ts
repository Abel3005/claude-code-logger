#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { ProxyServer } from './proxy-server';

const program = new Command();

program
  .name('claude-code-logger')
  .description('HTTP/HTTPS proxy logger for analyzing Claude Code traffic')
  .version('1.0.0');

// Start command - original single-user mode
program
  .command('start')
  .description('Start the proxy server (single-user mode)')
  .option('-p, --port <port>', 'Local port to listen on', (val) => parseInt(val), 8000)
  .option('-h, --host <host>', 'Remote host address', 'api.anthropic.com')
  .option('-r, --remote-port <port>', 'Remote port', (val) => parseInt(val), 443)
  .option('--https', 'Use HTTPS for remote connection', true)
  .option('--local-https', 'Accept HTTPS connections locally', false)
  .option('--log-body', 'Log request and response bodies', false)
  .option('--merge-sse', 'Merge Server-Sent Events into readable messages', false)
  .option('--debug', 'Show debug messages for troubleshooting', false)
  .option('--chat-mode', 'Show only chat conversation with live streaming', true)
  .option('-v, --verbose', 'Show full prompts without truncation', false)
  .action(async (options) => {
    try {
      const server = new ProxyServer({
        localPort: options.port,
        remoteHost: options.host,
        remotePort: options.remotePort,
        useHttps: options.https,
        localHttps: options.localHttps,
        logBody: options.logBody,
        mergeSse: options.mergeSse,
        debug: options.debug,
        chatMode: options.chatMode,
        verbose: options.verbose
      });

      await server.start();

      console.log(chalk.green(`🚀 Proxy server started on ${options.localHttps ? 'https' : 'http'}://localhost:${options.port}`));
      console.log(chalk.blue(`📡 Forwarding to ${options.https ? 'https' : 'http'}://${options.host}:${options.remotePort}`));
      console.log(chalk.yellow('📝 Logging all traffic to console...'));
      console.log(chalk.gray('Press Ctrl+C to stop'));

    } catch (error) {
      console.error(chalk.red('❌ Failed to start proxy server:'), error);
      process.exit(1);
    }
  });

// Server command - multi-user mode
program
  .command('server')
  .description('Start the proxy server in multi-user mode')
  .option('-p, --port <port>', 'Local port to listen on', (val) => parseInt(val), 8000)
  .option('-b, --bind <address>', 'Bind address (0.0.0.0 for all interfaces)', '0.0.0.0')
  .option('-h, --host <host>', 'Remote host address', 'api.anthropic.com')
  .option('-r, --remote-port <port>', 'Remote port', (val) => parseInt(val), 443)
  .option('--https', 'Use HTTPS for remote connection', true)
  .option('--local-https', 'Accept HTTPS connections locally', false)
  .option('--log-body', 'Log request and response bodies', false)
  .option('--merge-sse', 'Merge Server-Sent Events into readable messages', false)
  .option('--debug', 'Show debug messages for troubleshooting', false)
  .option('--chat-mode', 'Show only chat conversation with live streaming', true)
  .option('-v, --verbose', 'Show full prompts without truncation', false)
  .option('--logs-dir <path>', 'Directory for log files', './logs')
  .action(async (options) => {
    try {
      const server = new ProxyServer({
        localPort: options.port,
        remoteHost: options.host,
        remotePort: options.remotePort,
        useHttps: options.https,
        localHttps: options.localHttps,
        logBody: options.logBody,
        mergeSse: options.mergeSse,
        debug: options.debug,
        chatMode: options.chatMode,
        verbose: options.verbose,
        // Multi-user options
        multiUser: true,
        bindAddress: options.bind,
        logsDir: options.logsDir
      });

      await server.start();

      const protocol = options.localHttps ? 'https' : 'http';
      const bindDisplay = options.bind === '0.0.0.0' ? 'all interfaces' : options.bind;

      console.log(chalk.green(`🚀 Multi-user proxy server started`));
      console.log(chalk.blue(`📡 Listening on ${protocol}://${options.bind}:${options.port} (${bindDisplay})`));
      console.log(chalk.blue(`📡 Forwarding to ${options.https ? 'https' : 'http'}://${options.host}:${options.remotePort}`));
      console.log(chalk.yellow(`📁 Logs directory: ${options.logsDir}`));
      console.log('');
      console.log(chalk.cyan('📋 Client Configuration:'));
      console.log(chalk.white(`   export ANTHROPIC_BASE_URL="${protocol}://<server-ip>:${options.port}/user/<username>"`));
      console.log('');
      console.log(chalk.gray('   Example:'));
      console.log(chalk.gray(`   export ANTHROPIC_BASE_URL="${protocol}://192.168.1.100:${options.port}/user/alice"`));
      console.log('');
      console.log(chalk.gray('Press Ctrl+C to stop'));

    } catch (error) {
      console.error(chalk.red('❌ Failed to start proxy server:'), error);
      process.exit(1);
    }
  });

program.parse();
