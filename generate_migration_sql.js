const fs = require('fs');

const inputPath = 'Codeshastra Export.json';
const outputPath = 'firebase_to_supabase_migration.sql';

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};

const toBool = (v) => {
  if (v === null || v === undefined || v === '') return 'FALSE';
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' ? 'TRUE' : 'FALSE';
};

const toInt = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return 'NULL';
  const n = parseInt(String(v).trim(), 10);
  return Number.isNaN(n) ? 'NULL' : String(n);
};

const toFloat = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return 'NULL';
  const n = Number(v);
  return Number.isNaN(n) ? 'NULL' : String(n);
};

const trimStr = (v) => (v === null || v === undefined ? null : String(v).trim());

const checkpoints = (data.checkpointDetails || [])
  .filter((c) => c && typeof c === 'object')
  .map((c) => ({
    checkpoint_real_name: trimStr(c.checkpointRealName),
    title: trimStr(c.title),
    description: trimStr(c.description),
    day: toInt(c.day),
    time: trimStr(c.time),
  }))
  .filter((c) => c.checkpoint_real_name);

const criteria = ['Innovation', 'Functionality', 'Presentation', 'Feasibility', 'UI/UX'];

const admins = (data.adminData || [])
  .filter((a) => a && typeof a === 'object')
  .map((a) => ({
    name: trimStr(a.name),
    email: trimStr(a.email),
    password: trimStr(a.password),
    position: trimStr(a.position),
    edit_access: toBool(a.editAccess),
    view_result_access: toBool(a.viewResultAccess),
    checkpoints: Array.isArray(a.checkpoints) ? a.checkpoints : [],
  }))
  .filter((a) => a.email);

const checkpointNames = Array.isArray(data.checkpointNames) ? data.checkpointNames.map(trimStr) : [];

const adminCheckpointRows = [];
for (const a of admins) {
  for (let i = 1; i < a.checkpoints.length; i++) {
    const cpRealName = checkpointNames[i - 1];
    const cpObj = a.checkpoints[i];
    if (!cpRealName || !cpObj || typeof cpObj !== 'object') continue;
    adminCheckpointRows.push({
      admin_email: a.email,
      checkpoint_real_name: cpRealName,
      status: toBool(cpObj.status),
    });
  }
}

const judgesRaw = (((data.judgeData || {}).judge) || [])
  .filter((j) => j && typeof j === 'object');

const judges = judgesRaw.map((j) => ({
  name: trimStr(j.name),
  email: trimStr(j.email),
  password: trimStr(j.password),
  description: trimStr(j.description),
  ps_no: toInt(j.ps_no),
  ps_title: trimStr(j.ps_title),
  next_round_top_count: toInt(j.nextRoundTopCount),
  round1_finished: toBool(j.round1Finished),
  round2_finished: toBool(j.round2Finished),
  round1: j.round1 || null,
  round2: j.round2 || null,
})).filter((j) => j.email);

const teamMap = new Map();
const upsertTeam = (code, name) => {
  const c = trimStr(code);
  const n = trimStr(name);
  if (!c) return;
  if (!teamMap.has(c)) {
    teamMap.set(c, n || null);
    return;
  }
  const existing = teamMap.get(c);
  if (!existing && n) teamMap.set(c, n);
};

const roundTeamRows = [];
const roundTeamKey = new Set();
const scoreRows = [];
const resultRows = [];

for (const j of judges) {
  const rounds = [
    { no: 1, payload: j.round1 },
    { no: 2, payload: j.round2 },
  ];

  for (const r of rounds) {
    const teams = Array.isArray((r.payload || {}).teams) ? r.payload.teams : [];
    for (const t of teams) {
      const teamCode = trimStr(t.team_id);
      const teamName = trimStr(t.team_name);
      upsertTeam(teamCode, teamName);

      if (teamCode) {
        const rtKey = `${j.email}|${teamCode}|${r.no}`;
        if (!roundTeamKey.has(rtKey)) {
          roundTeamKey.add(rtKey);
          roundTeamRows.push({ judge_email: j.email, team_code: teamCode, round: r.no });
        }
      }

      const scores = Array.isArray(t.score) ? t.score : [];
      for (let idx = 0; idx < Math.min(scores.length, criteria.length); idx++) {
        const scoreVal = toInt(scores[idx]);
        if (!teamCode || scoreVal === 'NULL') continue;
        scoreRows.push({
          judge_email: j.email,
          team_code: teamCode,
          round: r.no,
          criterion_name: criteria[idx],
          score: scoreVal,
        });
      }
    }
  }

  const r1Results = (j.round1 && j.round1.results && typeof j.round1.results === 'object') ? j.round1.results : {};
  for (const [teamCode, resultObj] of Object.entries(r1Results)) {
    if (!resultObj || typeof resultObj !== 'object') continue;
    upsertTeam(teamCode, resultObj.team_name);
    const rank = toFloat(resultObj.rank);
    if (!trimStr(teamCode) || rank === 'NULL') continue;
    resultRows.push({
      judge_email: j.email,
      team_code: trimStr(teamCode),
      round: 1,
      rank,
    });
  }
}

const globalButton = toBool(data.button_visibility);

const teams = Array.from(teamMap.entries())
  .map(([team_code, team_name]) => ({ team_code, team_name }))
  .sort((a, b) => a.team_code.localeCompare(b.team_code));

let sql = '';
sql += '-- Firebase -> Supabase migration script\n';
sql += '-- Generated from Codeshastra Export.json\n\n';
sql += 'BEGIN;\n\n';

sql += '-- 1) checkpoints\n';
sql += 'INSERT INTO checkpoints (checkpoint_real_name, title, description, day, time)\nVALUES\n';
sql += checkpoints.map((c) => `  (${q(c.checkpoint_real_name)}, ${q(c.title)}, ${q(c.description)}, ${c.day}, ${q(c.time)})`).join(',\n');
sql += '\nON CONFLICT (checkpoint_real_name) DO UPDATE\nSET title = EXCLUDED.title,\n    description = EXCLUDED.description,\n    day = EXCLUDED.day,\n    time = EXCLUDED.time;\n\n';

sql += '-- 2) criteria\n';
sql += 'INSERT INTO criteria (name)\nSELECT v.name\nFROM (VALUES\n';
sql += criteria.map((c) => `  (${q(c)})`).join(',\n');
sql += '\n) AS v(name)\nWHERE NOT EXISTS (SELECT 1 FROM criteria c WHERE c.name = v.name);\n\n';

sql += '-- 3) admins\n';
sql += 'INSERT INTO admins (name, email, password, position, edit_access, view_result_access)\nVALUES\n';
sql += admins.map((a) => `  (${q(a.name)}, ${q(a.email)}, ${q(a.password)}, ${q(a.position)}, ${a.edit_access}, ${a.view_result_access})`).join(',\n');
sql += '\nON CONFLICT (email) DO UPDATE\nSET name = EXCLUDED.name,\n    password = EXCLUDED.password,\n    position = EXCLUDED.position,\n    edit_access = EXCLUDED.edit_access,\n    view_result_access = EXCLUDED.view_result_access;\n\n';

sql += '-- 4) admin_checkpoints\n';
sql += 'WITH src(admin_email, checkpoint_real_name, status) AS (\n  VALUES\n';
sql += adminCheckpointRows.map((r) => `  (${q(r.admin_email)}, ${q(r.checkpoint_real_name)}, ${r.status})`).join(',\n');
sql += '\n), mapped AS (\n  SELECT a.id AS admin_id, c.id AS checkpoint_id, src.status\n  FROM src\n  JOIN admins a ON btrim(lower(a.email)) = btrim(lower(src.admin_email))\n  JOIN checkpoints c ON c.checkpoint_real_name = src.checkpoint_real_name\n)\nINSERT INTO admin_checkpoints (admin_id, checkpoint_id, status)\nSELECT m.admin_id, m.checkpoint_id, m.status\nFROM mapped m\nWHERE NOT EXISTS (\n  SELECT 1\n  FROM admin_checkpoints ac\n  WHERE ac.admin_id = m.admin_id\n    AND ac.checkpoint_id = m.checkpoint_id\n);\n\n';

sql += '-- 5) global_settings\n';
sql += 'INSERT INTO global_settings (button_visibility)\nVALUES (' + globalButton + ');\n\n';

sql += '-- 6) judges\n';
sql += 'INSERT INTO judges (name, email, password, description, ps_no, ps_title, next_round_top_count, round1_finished, round2_finished)\nVALUES\n';
sql += judges.map((j) => `  (${q(j.name)}, ${q(j.email)}, ${q(j.password)}, ${q(j.description)}, ${j.ps_no}, ${q(j.ps_title)}, ${j.next_round_top_count}, ${j.round1_finished}, ${j.round2_finished})`).join(',\n');
sql += '\nON CONFLICT (email) DO UPDATE\nSET name = EXCLUDED.name,\n    password = EXCLUDED.password,\n    description = EXCLUDED.description,\n    ps_no = EXCLUDED.ps_no,\n    ps_title = EXCLUDED.ps_title,\n    next_round_top_count = EXCLUDED.next_round_top_count,\n    round1_finished = EXCLUDED.round1_finished,\n    round2_finished = EXCLUDED.round2_finished;\n\n';

sql += '-- 7) teams\n';
sql += 'INSERT INTO teams (team_code, team_name)\nVALUES\n';
sql += teams.map((t) => `  (${q(t.team_code)}, ${q(t.team_name)})`).join(',\n');
sql += '\nON CONFLICT (team_code) DO UPDATE\nSET team_name = COALESCE(EXCLUDED.team_name, teams.team_name);\n\n';

sql += '-- 8) round_teams\n';
sql += 'WITH src(judge_email, team_code, round) AS (\n  VALUES\n';
sql += roundTeamRows.map((r) => `  (${q(r.judge_email)}, ${q(r.team_code)}, ${r.round})`).join(',\n');
sql += '\n), mapped AS (\n  SELECT j.id AS judge_id, t.id AS team_id, src.round\n  FROM src\n  JOIN judges j ON btrim(lower(j.email)) = btrim(lower(src.judge_email))\n  JOIN teams t ON t.team_code = src.team_code\n)\nINSERT INTO round_teams (judge_id, team_id, round)\nSELECT m.judge_id, m.team_id, m.round\nFROM mapped m\nWHERE NOT EXISTS (\n  SELECT 1\n  FROM round_teams rt\n  WHERE rt.judge_id = m.judge_id\n    AND rt.team_id = m.team_id\n    AND rt.round = m.round\n);\n\n';

sql += '-- 9) scores\n';
sql += 'WITH src(judge_email, team_code, round, criterion_name, score) AS (\n  VALUES\n';
sql += scoreRows.map((s) => `  (${q(s.judge_email)}, ${q(s.team_code)}, ${s.round}, ${q(s.criterion_name)}, ${s.score})`).join(',\n');
sql += '\n), mapped AS (\n  SELECT j.id AS judge_id, t.id AS team_id, src.round, c.id AS criteria_id, src.score\n  FROM src\n  JOIN judges j ON btrim(lower(j.email)) = btrim(lower(src.judge_email))\n  JOIN teams t ON t.team_code = src.team_code\n  JOIN criteria c ON c.name = src.criterion_name\n)\nINSERT INTO scores (judge_id, team_id, round, criteria_id, score)\nSELECT m.judge_id, m.team_id, m.round, m.criteria_id, m.score\nFROM mapped m\nWHERE NOT EXISTS (\n  SELECT 1\n  FROM scores s\n  WHERE s.judge_id = m.judge_id\n    AND s.team_id = m.team_id\n    AND s.round = m.round\n    AND s.criteria_id = m.criteria_id\n);\n\n';

sql += '-- 10) round_results\n';
sql += 'WITH src(judge_email, team_code, round, rank) AS (\n  VALUES\n';
sql += resultRows.map((r) => `  (${q(r.judge_email)}, ${q(r.team_code)}, ${r.round}, ${r.rank})`).join(',\n');
sql += '\n), mapped AS (\n  SELECT j.id AS judge_id, t.id AS team_id, src.round, src.rank\n  FROM src\n  JOIN judges j ON btrim(lower(j.email)) = btrim(lower(src.judge_email))\n  JOIN teams t ON t.team_code = src.team_code\n)\nINSERT INTO round_results (judge_id, team_id, round, rank)\nSELECT m.judge_id, m.team_id, m.round, m.rank\nFROM mapped m\nWHERE NOT EXISTS (\n  SELECT 1\n  FROM round_results rr\n  WHERE rr.judge_id = m.judge_id\n    AND rr.team_id = m.team_id\n    AND rr.round = m.round\n);\n\n';

sql += 'COMMIT;\n';

fs.writeFileSync(outputPath, sql, 'utf8');

console.log(JSON.stringify({
  checkpoints: checkpoints.length,
  admins: admins.length,
  admin_checkpoints: adminCheckpointRows.length,
  judges: judges.length,
  teams: teams.length,
  round_teams: roundTeamRows.length,
  scores: scoreRows.length,
  round_results: resultRows.length
}, null, 2));
console.log(`Wrote ${outputPath}`);
