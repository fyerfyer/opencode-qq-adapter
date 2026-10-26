import { connectPluginUi } from "./sdk.js";

const connection = document.querySelector("#connection");
const text = document.querySelector("#text");
const add = document.querySelector("#add");
const items = document.querySelector("#items");
const empty = document.querySelector("#empty");
const meta = document.querySelector("#meta");

async function main() {
  const bridge = await connectPluginUi();
  connection.textContent = "bridge 已连接";
  connection.classList.add("ok");
  meta.textContent = `${bridge.context.pluginId} · ${bridge.context.pageId} · protocol ${bridge.context.protocol}`;

  const render = async () => {
    const result = await bridge.api.get("/items");
    items.replaceChildren();
    empty.hidden = result.items.length > 0;
    for (const item of result.items) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = item.text;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "删除";
      remove.addEventListener("click", async () => {
        await bridge.api.delete(`/items/${item.id}`);
        await render();
      });
      row.append(label, remove);
      items.append(row);
    }
  };

  add.addEventListener("click", async () => {
    const value = text.value.trim();
    if (value.length === 0) {
      await bridge.ui.toast("先写点什么", "warning");
      return;
    }
    await bridge.api.post("/items", { text: value });
    text.value = "";
    await render();
  });

  document.querySelector("#toast").addEventListener("click", () => {
    void bridge.ui.toast("来自 UI Demo 的 toast", "success");
  });

  document.querySelector("#confirm").addEventListener("click", async () => {
    const confirmed = await bridge.ui.confirm({
      title: "删除全部记录？",
      description: "示例只做确认，不会真的删除。",
      confirmText: "继续",
      destructive: true,
    });
    await bridge.ui.toast(confirmed ? "已确认" : "已取消", confirmed ? "success" : "info");
  });

  document.querySelector("#plugins").addEventListener("click", () => {
    void bridge.ui.navigate("/plugins");
  });

  await render();
}

main().catch((error) => {
  connection.textContent = "bridge 连接失败";
  meta.textContent = error instanceof Error ? error.message : String(error);
});
