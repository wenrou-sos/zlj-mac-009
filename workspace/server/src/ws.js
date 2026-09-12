// 极简 WebSocket 连接池：服务端 -> 所有看板的事件广播
import { WebSocketServer } from 'ws';

class Hub {
  attach(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
    });
    // 心跳清理断开的连接
    this.timer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);
  }

  broadcast(type, payload) {
    if (!this.wss) return;
    const data = JSON.stringify({ type, payload, ts: Date.now() });
    for (const ws of this.wss.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

export const hub = new Hub();
