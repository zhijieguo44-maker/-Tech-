import { join } from "node:path";
import { reply } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

const tasks = createJsonTaskStore(join("data", "tasks.json"));
const app = createApp({ reply, tasks });
const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => console.log(`小明智能体已启动：http://127.0.0.1:${port}`));
