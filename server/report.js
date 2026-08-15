import { chatCompletion } from './llm.js';
import { query } from './db.js';
import { initStore } from './store.js';

export async function generateWeeklyReport(projects) {
  await initStore();
  const list = (projects || []).map((p) => ({
    name: p.name,
    status: p.status,
    progress: p.progress,
    progressSource: p.progressSource,
    port: p.port,
    url: p.url,
    remoteUrl: p.remoteUrl,
    lastCommitAt: p.lastCommitAt,
    notes: p.notes,
    aiSummary: (p.aiSummary || '').slice(0, 400),
    live: p.health?.live,
    stack: p.stack,
    nodeName: p.nodeName || null,
  }));

  const system =
    '你是项目管理助手，负责写给自己看的 vibecoding 周报。用简洁中文，结构固定：' +
    '1) 本周总览（2-3句）2) 有进展的项目（要点）3) 停滞/风险项目 4) 建议下周聚焦的 3 件事。' +
    '不要编造没有提供的事实；没有信息就写「信息不足」。';

  const user = [
    `今天：${new Date().toISOString().slice(0, 10)}`,
    `项目数：${list.length}`,
    '',
    '项目快照 JSON：',
    JSON.stringify(list, null, 2),
  ].join('\n');

  const result = await chatCompletion({ system, user, temperature: 0.4 });
  const report = {
    id: `weekly-${Date.now()}`,
    type: 'weekly',
    createdAt: new Date().toISOString(),
    model: result.model,
    content: result.text,
    projectCount: list.length,
  };

  await query(
    `INSERT INTO reports (id, type, content, model, project_count, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
    [
      report.id,
      report.type,
      report.content,
      report.model,
      report.projectCount,
      JSON.stringify(report),
      report.createdAt,
    ],
  );

  // keep last 20
  await query(
    `DELETE FROM reports
     WHERE type = 'weekly'
       AND id NOT IN (
         SELECT id FROM reports WHERE type = 'weekly' ORDER BY created_at DESC LIMIT 20
       )`,
  );

  return report;
}

export async function getLatestWeeklyReport() {
  await initStore();
  const { rows } = await query(
    `SELECT data, content, model, project_count, created_at, id, type
     FROM reports WHERE type = 'weekly' ORDER BY created_at DESC LIMIT 1`,
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    ...(row.data || {}),
    id: row.id,
    type: row.type,
    content: row.content,
    model: row.model,
    projectCount: row.project_count,
    createdAt: row.created_at,
  };
}

export async function listWeeklyReports() {
  await initStore();
  const { rows } = await query(
    `SELECT data, content, model, project_count, created_at, id, type
     FROM reports WHERE type = 'weekly' ORDER BY created_at DESC LIMIT 20`,
  );
  return rows.map((row) => ({
    ...(row.data || {}),
    id: row.id,
    type: row.type,
    content: row.content,
    model: row.model,
    projectCount: row.project_count,
    createdAt: row.created_at,
  }));
}
