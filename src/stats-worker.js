// Child process for src/stats.js: receives a list of transcript paths over IPC,
// streams each one through sessionRecord() and sends the compact records back.
import { sessionRecord } from './stats.js';

process.on('message', async (m) => {
  if (!m || m.type !== 'files') return;
  for (const file of m.files) {
    let record = null;
    try { record = await sessionRecord(file, { projectsDir: m.projectsDir }); } catch { record = null; }
    process.send({ type: 'record', record });
  }
  process.send({ type: 'done' });
});
