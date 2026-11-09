import { constants, existsSync, copyFileSync } from "node:fs";
import net from "node:net";
import dotenv from "dotenv";
import pg from "pg";
import { concurrently } from "concurrently";
import { startLocalPostgres } from "./local-postgres.mjs";

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env", constants.COPYFILE_EXCL);
  console.log("Создан .env с настройками локальной PostgreSQL.");
}
dotenv.config();
function port(value, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error("Некорректный номер порта");
  return n;
}
async function available(host, number) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Порт ${number} занят. Остановите предыдущий запуск приложения (Ctrl+C в его терминале) и повторите npm run dev.`,
            )
          : error,
      ),
    );
    server.listen(number, host, () => server.close(resolve));
  });
}
async function checkDatabase() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 4000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => {});
  }
}
let ownedDatabase;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  const apiPort = port(process.env.PORT, 3001);
  const webPort = port(process.env.DEV_WEB_PORT, 5173);
  if (apiPort === webPort)
    throw new Error("Порты API и интерфейса должны отличаться");
  await available(process.env.HOST ?? "127.0.0.1", apiPort);
  await available("127.0.0.1", webPort);
  if (!process.env.DATABASE_URL) throw new Error("Укажите DATABASE_URL в .env");
  const url = new URL(process.env.DATABASE_URL);
  const managed =
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    (url.port || "5432") === "5432" &&
    url.pathname === "/mixcontrol" &&
    decodeURIComponent(url.username) === "mixcontrol" &&
    decodeURIComponent(url.password) === "mixcontrol";
  try {
    await checkDatabase();
    console.log("PostgreSQL доступна. Используется настроенная база.");
  } catch (error) {
    if (error.code !== "ECONNREFUSED" || !managed) {
      throw new Error(
        `Не удалось подключиться к PostgreSQL (${error.code ?? "ошибка подключения"}). Проверьте DATABASE_URL в .env и запуск указанного сервера БД.`,
      );
    }
    console.log("Запускаем постоянную локальную PostgreSQL из .postgres…");
    ownedDatabase = await startLocalPostgres();
    await checkDatabase();
  }
  if (!interrupted) {
    const running = concurrently(
      [
        { name: "api", command: "tsx watch server/index.ts" },
        {
          name: "web",
          command: "node scripts/dev-web.mjs",
          env: { ...process.env, DEV_WEB_PORT: String(webPort) },
        },
      ],
      { killOthersOn: ["failure", "success"], killTimeout: 5000 },
    );
    await running.result;
  }
} catch (error) {
  if (!interrupted) {
    console.error(
      "Не удалось запустить MixControl:",
      error instanceof Error
        ? error.message
        : "Один из процессов завершился с ошибкой. Подробности выше.",
    );
    process.exitCode = 1;
  }
} finally {
  if (ownedDatabase) {
    try {
      await ownedDatabase.stop();
      console.log(
        "Локальная PostgreSQL остановлена; данные сохранены в .postgres.",
      );
    } catch (error) {
      console.error(
        "Не удалось штатно остановить локальную PostgreSQL:",
        error?.message ?? error,
      );
      process.exitCode = 1;
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
