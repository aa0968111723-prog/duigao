/* 把對稿圖影編輯器鑲進其他網站：
 *   <script src="https://DUIGAO_ORIGIN/duigao-inlay.js"></script>
 *   DuigaoStudio.open({ origin, kind, name, onExport })
 * 對稿本體用 #studio?embed=1；Grok 編輯器 origin 用 /bridge?。
 */
(function (root) {
  "use strict";

  var SOURCE = "inlay";
  var PARENT = "duigao";

  function fileFromPayload(payload) {
    if (!payload) return null;
    if (payload.buffer) {
      return new File([payload.buffer], payload.filename || "studio.bin", {
        type: payload.mime || "application/octet-stream",
      });
    }
    if (payload.dataUrl) {
      var comma = payload.dataUrl.indexOf(",");
      var b64 = comma >= 0 ? payload.dataUrl.slice(comma + 1) : payload.dataUrl;
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], payload.filename || "studio.png", {
        type: payload.mime || "image/png",
      });
    }
    return null;
  }

  function studioSrc(origin, params) {
    var qs = params.toString();
    var host = "";
    try {
      host = new URL(origin).hostname;
    } catch (_) {}
    if (host.indexOf("127.0.0.1") >= 0 || host.indexOf("localhost") >= 0 || host.indexOf("grok") >= 0) {
      return origin + "/bridge?" + qs;
    }
    return origin + "/#studio?" + qs;
  }

  function open(opts) {
    opts = opts || {};
    var origin = (opts.origin || "").replace(/\/$/, "");
    if (!origin) throw new Error("DuigaoStudio.open: origin is required");
    var kind = opts.kind === "video" ? "video" : "poster";
    var params = new URLSearchParams();
    params.set("kind", kind);
    params.set("embed", "1");
    params.set("origin", location.origin);
    if (opts.name) params.set("name", opts.name);
    if (opts.width) params.set("w", String(opts.width));
    if (opts.height) params.set("h", String(opts.height));
    if (opts.roomId) params.set("room", opts.roomId);

    var overlay = document.createElement("div");
    overlay.setAttribute("data-inlay-overlay", "");
    overlay.setAttribute("data-studio-overlay", "");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;background:rgba(13,18,22,0.55);display:flex;flex-direction:column;";
    var iframe = document.createElement("iframe");
    iframe.src = studioSrc(origin, params);
    iframe.allow = "clipboard-write";
    iframe.style.cssText = "flex:1;width:100%;border:0;background:#fff;";
    overlay.appendChild(iframe);
    document.body.appendChild(overlay);

    function close() {
      window.removeEventListener("message", onMessage);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function onMessage(ev) {
      if (origin !== "*" && ev.origin !== origin) return;
      var data = ev.data;
      if (!data || data.source !== SOURCE) return;
      if (data.type === "inlay:ready") {
        try {
          iframe.contentWindow.postMessage(
            { source: PARENT, type: "duigao:hello", payload: { kind: kind, name: opts.name, roomId: opts.roomId } },
            origin,
          );
        } catch (_) {}
        if (typeof opts.onReady === "function") opts.onReady();
      }
      if (data.type === "inlay:export") {
        var file = fileFromPayload(data.payload);
        if (typeof opts.onExport === "function") opts.onExport({ file: file, payload: data.payload, kind: kind });
        close();
      }
      if (data.type === "inlay:cancel") {
        if (typeof opts.onCancel === "function") opts.onCancel();
        close();
      }
    }

    window.addEventListener("message", onMessage);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        if (typeof opts.onCancel === "function") opts.onCancel();
        close();
      }
    });
    return { close: close, iframe: iframe };
  }

  var api = { open: open, fileFromPayload: fileFromPayload };
  root.DuigaoStudio = api;
  root.Inlay = api;
})(typeof window !== "undefined" ? window : this);
