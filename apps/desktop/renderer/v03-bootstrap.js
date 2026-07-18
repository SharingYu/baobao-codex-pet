import "./v03.css";

function installV03Dom() {
  const canvas = document.querySelector("#pet-stage");
  canvas?.setAttribute("aria-label", "透明桌面宠物舞台；拖动宠物可放到窗口顶边，摸摸需先点击工具栏手掌");

  const quietStatus = document.querySelector("#quiet-status");
  if (quietStatus && !document.querySelector("#interaction-status")) {
    quietStatus.insertAdjacentHTML("afterend", '<div id="interaction-status" class="interaction-status" role="status" hidden></div>');
  }

  const shell = document.querySelector("#action-shell");
  if (shell) shell.innerHTML = `
    <div id="food-popover" class="popover" role="dialog" aria-label="选择食物" hidden>
      <div class="popover-head"><p id="food-active-status" class="popover-title">同一时间只放一份零食</p><button id="food-clear-button" class="clear-interaction" type="button" hidden>收起 / 取消</button></div>
      <div id="food-choices" class="choice-row"></div>
    </div>
    <div id="toy-popover" class="popover" role="dialog" aria-label="选择玩具" hidden>
      <div class="popover-head"><p id="toy-active-status" class="popover-title">同一时间只使用一件玩具</p><button id="toy-clear-button" class="clear-interaction" type="button" hidden>收起当前玩具</button></div>
      <div id="toy-choices" class="choice-row"></div>
    </div>
    <div id="pet-selector-popover" class="popover pet-selector-popover" role="dialog" aria-labelledby="pet-manager-title" hidden>
      <header class="pet-manager-head">
        <div>
          <p class="popover-kicker">宠物管理</p>
          <h2 id="pet-manager-title">宠物小屋</h2>
          <p id="current-pet-summary" class="current-pet-summary">当前没有显示中的宠物</p>
        </div>
        <button id="pet-selector-import-button" class="pet-manager-import" type="button"><span aria-hidden="true">＋</span> 添加宠物</button>
      </header>
      <p class="pet-manager-hint">点击卡片选择当前互动宠物；每只宠物都能独立调节大小和移动速度。</p>
      <div id="pet-list" class="pet-list" role="list" aria-label="已安装宠物"></div>
      <footer class="pet-manager-footer">
        <label class="platform-setting">
          <span><strong>窗口平台互动</strong><small>仅读取窗口位置和大小，不读取窗口内容</small></span>
          <input id="platform-toggle" type="checkbox" checked />
        </label>
      </footer>
    </div>
    <div id="petpack-popover" class="popover petpack-popover" role="dialog" aria-label="内容包管理" hidden>
      <p class="popover-title">运行器、宠物包、道具包彼此独立</p>
      <button id="import-petpack-button" class="import-petpack-button" type="button">
        <span class="import-mark" aria-hidden="true">＋</span><span><strong>导入宠物包</strong><small>.petpack 定制宠物包</small></span>
      </button>
      <button id="import-itempack-button" class="import-petpack-button" type="button">
        <span class="import-mark" aria-hidden="true">＋</span><span><strong>导入道具包</strong><small>.itempack 独立互动素材包</small></span>
      </button>
      <div class="installed-pack-section"><p class="installed-pack-title">已安装内容</p><div id="installed-packs" class="installed-pack-list"></div></div>
      <button id="quit-app-button" class="quit-app-button" type="button">退出程序</button>
    </div>
    <nav class="action-bar" aria-label="快捷操作">
      <button id="pet-button" class="action-button" type="button" data-action="pet" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.4 10.3c1.2-1.1 2.8-.4 3.6.7.8-1.1 2.4-1.8 3.6-.7 1.5 1.4.6 3.8-3.6 6.4-4.2-2.6-5.1-5-3.6-6.4Z"/><path d="M5.2 7.7c.8-.8 2-.4 2.4.6M16.4 8.3c.4-1 1.6-1.4 2.4-.6"/></svg><span>摸摸</span>
      </button>
      <button id="feed-button" class="action-button" type="button" data-action="feed" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.8 12.5h14.4c-.2 4-3.1 6.4-7.2 6.4s-7-2.4-7.2-6.4Z"/><path d="M8.1 9.8c.5-2 2.1-3.4 4.1-3.4 1.6 0 3 .8 3.7 2.2"/></svg><span>投喂</span>
      </button>
      <button id="toy-button" class="action-button" type="button" data-action="toy" aria-expanded="false" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="14.5" r="3.7"/><path d="M10.8 12c2.1-2.3 3.8-4.8 4.3-7.4M15.1 4.6c1.2.4 2.2 1.2 2.9 2.3"/></svg><span>玩具</span>
      </button>
      <button id="pet-selector-button" class="action-button pet-selector-button" type="button" data-action="pets" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11.5c-1.8 0-3.5 1.6-3.5 3.7 0 2.6 2.5 4.3 7.5 4.3s7.5-1.7 7.5-4.3c0-2.1-1.7-3.7-3.5-3.7"/><circle cx="7" cy="7.5" r="1.7"/><circle cx="17" cy="7.5" r="1.7"/><circle cx="12" cy="5.5" r="1.8"/></svg><span id="current-pet-label">选择宠物</span>
      </button>
      <button id="quiet-button" class="action-button" type="button" data-action="quiet" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.7 14.9A6.8 6.8 0 0 1 9.1 6.3a6.9 6.9 0 1 0 8.6 8.6Z"/></svg><span>安静</span>
      </button>
      <span class="bar-divider" aria-hidden="true"></span>
      <button id="petpack-button" class="petpack-button" type="button" aria-label="内容包管理" aria-expanded="false" title="内容包管理">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v9M8.5 10.5 12 14l3.5-3.5M6 16.5v1.2c0 .7.6 1.3 1.3 1.3h9.4c.7 0 1.3-.6 1.3-1.3v-1.2"/></svg>
      </button>
    </nav>`;

  const emptyShell = document.querySelector("#empty-shell");
  if (emptyShell) {
    const title = emptyShell.querySelector("h1");
    const copy = emptyShell.querySelector("p:not(.empty-kicker)");
    if (title) title.textContent = "先带一只宠物回到桌面";
    if (copy) copy.textContent = "运行器本身不附带宠物或道具。导入 .petpack 后选择让谁出现，再按需安装 .itempack。";
  }
  if (emptyShell && !document.querySelector("#resting-shell")) {
    emptyShell.insertAdjacentHTML("afterend", `
      <section id="resting-shell" class="empty-shell resting-shell" role="status" hidden>
        <p class="empty-kicker">PETS ARE RESTING</p><h1>宠物们都在休息</h1>
        <p>宠物包和亲密记录都保留着。选择想让谁回到桌面即可。</p>
        <div class="empty-actions"><button id="resting-choose-pet" class="primary-button" type="button">选择宠物</button></div>
      </section>`);
  }
}

installV03Dom();
import("./main-v03.js");
