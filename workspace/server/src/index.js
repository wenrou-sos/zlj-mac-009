import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { seedIfEmpty, pruneReadings } from './seed.js';
import { startSimulator } from './simulator.js';
import { runEscalationSweep, runOfflineWatchdog } from './alarms.js';
import { router } from './routes.js';
import { hub } from './ws.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

seedIfEmpty();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', router);

// 生产环境托管前端构建产物
const dist = join(__dirname, '..', '..', 'client', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

const server = http.createServer(app);
hub.attach(server);

server.listen(PORT, () => {
  console.log(`❄️  ColdChain TMS server: http://localhost:${PORT}`);
});

startSimulator();
setInterval(runOfflineWatchdog, 5_000);      // 心跳看门狗：按最后上报时间超时判定离线
setInterval(runEscalationSweep, 15_000);   // 每 15s 扫描一次告警升级
setInterval(pruneReadings, 30 * 60_000);  // 定期清理超期读数
