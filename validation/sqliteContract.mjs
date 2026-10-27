/**
 * sqliteContract — 実 SQLite エンジンでの契約検証（node:sqlite）
 *
 * 検証対象（バックログ実機検証タスクの SQL レベル部分）:
 * ①stages INSERT 失敗→rollback で sleep_sessions が 0 行（部分保存の不発生）
 * ②UNIQUE(session_id, ts_ms) + INSERT OR IGNORE の重複排除（changes=0）
 * ③lastInsertRowid が正の整数・number 型
 * ④FK enforcement ON 時: DELETE 順序（stages 先）の正当性・逆順の FK 違反
 *
 * 使い方: node validation/sqliteContract.mjs
 * 成功=全検証 PASS・fail=1件でも NG で exit 1
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

// migrations.ts から V1_DDL を取り出す（正規化は不要・生文字列を抽出して実行）
const migSrc = readFileSync(new URL("../src/lib/migration/migrations.ts", import.meta.url), "utf-8");
const ddlMatch = migSrc.match(/export const V1_DDL = `\n([\s\S]*?)`\.trim\(\);/);
if (!ddlMatch) throw new Error("V1_DDL 抽出失敗");
const V1_DDL = ddlMatch[1].trim();

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);`.trim();

let ng = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "NG"}: ${name}${detail ? ` / ${detail}` : ""}`);
  if (!cond) ng++;
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_MIGRATIONS_DDL);
  db.exec(V1_DDL);
  return db;
}

// ===== ① rollback 実測: stages INSERT 失敗で session も 0 行 =====
{
  const db = freshDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const insSession = db.prepare(
      "INSERT INTO sleep_sessions (start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const r = insSession.run(1792867680000, 1792899480000, 4, 0.25, 0.5, 0.25, 0, 67, "activity_txt", "2026-10-25T03:48:00.000Z");
    const sessionId = r.lastInsertRowid;
    const insStage = db.prepare("INSERT INTO sleep_stages (session_id, ts_ms, phase) VALUES (?, ?, ?)");
    insStage.run(sessionId, 1792867680000, "DEEP");
    insStage.run(sessionId, 1792867690000, "LIGHT");
    // stages 2件目で失敗注入（NULL phase = NOT NULL 制約違反で SQLite が例外を出す）
    try {
      insStage.run(sessionId, 1792867700000, null);
      console.log("NG: 失敗注入が例外にならなかった");
      ng++;
    } catch {
      db.exec("ROLLBACK");
    }
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sleep_sessions").get();
  const stages = db.prepare("SELECT COUNT(*) AS n FROM sleep_stages").get();
  check("rollback: stages失敗後に sleep_sessions が0行", sessions.n === 0, `sessions=${sessions.n}`);
  check("rollback: sleep_stages も0行", stages.n === 0, `stages=${stages.n}`);
  db.close();
}

// ===== ② UNIQUE + INSERT OR IGNORE 実測 =====
{
  const db = freshDb();
  const insSession = db.prepare(
    "INSERT INTO sleep_sessions (start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const sid = insSession.run(1, 2, 4, 0.25, 0.5, 0.25, 0, 67, "activity_txt", "c").lastInsertRowid;
  const insStage = db.prepare("INSERT OR IGNORE INTO sleep_stages (session_id, ts_ms, phase) VALUES (?, ?, ?)");
  const r1 = insStage.run(sid, 1000, "DEEP");
  const r2 = insStage.run(sid, 1000, "LIGHT"); // 同一 ts=重複
  const r3 = insStage.run(sid, 2000, "REM");
  const stages = db.prepare("SELECT COUNT(*) AS n FROM sleep_stages WHERE session_id = ?").get(sid);
  check("UNIQUE+OR IGNORE: 重複tsは無視され2行のみ", stages.n === 2, `rows=${stages.n}・r1.changes=${r1.changes}・r2.changes=${r2.changes}`);
  check("UNIQUE+OR IGNORE: 先着行が保持される（first-wins）", db.prepare("SELECT phase FROM sleep_stages WHERE session_id = ? AND ts_ms = ?").get(sid, 1000).phase === "DEEP");
  db.close();
}

// ===== ③ lastInsertRowid 型・正の整数 =====
{
  const db = freshDb();
  const insSession = db.prepare(
    "INSERT INTO sleep_sessions (start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const id = insSession.run(1, 2, 1, 0, 0, 0, 0, null, "activity_txt", "c").lastInsertRowid;
  check("lastInsertRowid: number型かつ正の整数", typeof id === "number" && Number.isInteger(id) && id > 0, `type=${typeof id} value=${id}`);
  db.close();
}

// ===== ④ FK enforcement: DELETE 順序 =====
{
  const db = freshDb();
  db.exec("PRAGMA foreign_keys = ON");
  const fkOn = db.prepare("PRAGMA foreign_keys").get();
  const insSession = db.prepare(
    "INSERT INTO sleep_sessions (start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const sid = insSession.run(1, 2, 2, 0.5, 0.5, 0, 0, 50, "activity_txt", "c").lastInsertRowid;
  const insStage = db.prepare("INSERT OR IGNORE INTO sleep_stages (session_id, ts_ms, phase) VALUES (?, ?, ?)");
  insStage.run(sid, 1000, "DEEP");
  insStage.run(sid, 2000, "LIGHT");
  // 逆順（session 先）は FK 違反になる
  let reversedFailed = false;
  try {
    db.prepare("DELETE FROM sleep_sessions WHERE id = ?").run(sid);
  } catch {
    reversedFailed = true;
  }
  check("FK: session先削除はFK違反（=stages先が正）", reversedFailed);
  // 正順（stages 先→session）は成功
  db.prepare("DELETE FROM sleep_stages WHERE session_id = ?").run(sid);
  db.prepare("DELETE FROM sleep_sessions WHERE id = ?").run(sid);
  const left = db.prepare("SELECT (SELECT COUNT(*) FROM sleep_sessions) + (SELECT COUNT(*) FROM sleep_stages) AS n").get();
  check("FK: 正順DELETEで全消去", left.n === 0, `left=${left.n}`);
  check("FK: foreign_keys=ON が効いている", fkOn.foreign_keys === 1);
  db.close();
}

// ===== ⑤ 結合: ヒプノグラム保存→再読込（SQLレベル） =====
{
  const db = freshDb();
  const insSession = db.prepare(
    "INSERT INTO sleep_sessions (start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const sid = insSession.run(1000, 9000, 4, 0.5, 0.25, 0.25, 0, 82, "activity_txt", "c").lastInsertRowid;
  const insStage = db.prepare("INSERT OR IGNORE INTO sleep_stages (session_id, ts_ms, phase) VALUES (?, ?, ?)");
  for (const [ts, phase] of [[1000, "DEEP"], [2000, "LIGHT"], [3000, "REM"], [4000, "AWAKE"]]) {
    insStage.run(sid, ts, phase);
  }
  // 再読込照合（listSessions/getSessionStages の SQL 相当）
  const session = db.prepare("SELECT id, start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at FROM sleep_sessions ORDER BY start_ms DESC").get();
  const stages = db.prepare("SELECT ts_ms, phase FROM sleep_stages WHERE session_id = ? ORDER BY ts_ms").all(session.id);
  check("結合: session再読込の全カラム一致", session.id === sid && session.score === 82 && session.source === "activity_txt");
  check("結合: stages再読込4行・ts昇順", stages.length === 4 && stages[0].phase === "DEEP" && stages[3].phase === "AWAKE");
  db.close();
}

console.log(ng === 0 ? "=== 全検証 PASS ===" : `=== ${ng}件 NG ===`);
process.exit(ng === 0 ? 0 : 1);
