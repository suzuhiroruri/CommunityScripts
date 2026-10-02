/* =========================================================================
 * Unwatched Dot (Stash UI plugin)
 *
 * 今開いているシーンがまだ未再生なら、タブのファビコンへ丸を重ねる。
 * 視聴済み（または設定次第で途中まで見た）なら印を外す。シーン詳細ページ以外でも外す。
 *
 * 描画は canvas で行い requestAnimationFrame を使わない（背面タブでは rAF が止まるため）。
 * play_count はページに載らないので /graphql の findScenes で引く。
 * ※ファビコンを差し替えるので、同じく favicon を触る PlayingDot とは併用しない。
 * ========================================================================= */
(function () {
  "use strict";

  var PLUGIN_ID = "UnwatchedDot";
  var SOURCE_ICON = "/apple-touch-icon.png";   // canvas へ描けるよう PNG を使う
  var PLAIN_ICON = "/favicon.ico";
  var SIZE = 32;

  var settings = { dotColor: "#e02020", resumeCountsAsWatched: true };
  var langCode = "en";   // Stash の UI 言語。設定画面の翻訳に使う
  var baseImage = null;
  var dotIcon = null;
  var marked = false;
  var cache = {};       // id -> { play_count, resume_time }
  var lastKey = null;   // 直近に評価した状態（URL変化の検知用）

  function gql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      return j.data;
    });
  }

  function loadSettings() {
    return gql("{configuration{plugins interface{language}}}").then(function (d) {
      var cfg = ((d.configuration || {}).plugins || {})[PLUGIN_ID] || {};
      if (cfg.dotColor) settings.dotColor = String(cfg.dotColor);
      if (cfg.resumeCountsAsWatched !== undefined) {
        settings.resumeCountsAsWatched = cfg.resumeCountsAsWatched === true;
      }
      var lang = ((d.configuration || {}).interface || {}).language;
      if (lang) langCode = lang;
    }).catch(function () { /* 既定値のまま */ });
  }

  function loadBase() {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = SOURCE_ICON;
    });
  }

  /// 元アイコンの右下に丸を重ねた data URL を作る
  function buildDotIcon() {
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    var ctx = canvas.getContext("2d");
    if (baseImage) ctx.drawImage(baseImage, 0, 0, SIZE, SIZE);
    var r = SIZE * 0.26;
    var cx = SIZE - r - 1;
    var cy = SIZE - r - 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.65)";   // 明るいアイコンでも沈まないよう縁を敷く
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
    ctx.fillStyle = settings.dotColor;
    ctx.fill();
    return canvas.toDataURL("image/png");
  }

  /// アイコン指定を1本だけ残して差し替える
  function setIcon(href, type) {
    document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]').forEach(function (l) {
      l.parentNode.removeChild(l);
    });
    var link = document.createElement("link");
    link.rel = "icon";
    link.type = type;
    link.href = href;
    link.setAttribute("data-unwatched-dot", marked ? "on" : "off");
    document.head.appendChild(link);
  }

  function setMarked(on) {
    if (on === marked && document.querySelector("link[data-unwatched-dot]")) return;
    marked = on;
    if (on) {
      if (!dotIcon) dotIcon = buildDotIcon();
      setIcon(dotIcon, "image/png");
    } else {
      setIcon(PLAIN_ICON + "?t=" + Date.now(), "image/x-icon");
    }
  }

  function currentSceneId() {
    var m = location.pathname.match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function isUnwatched(s) {
    if (!s) return false;
    if ((s.play_count || 0) > 0) return false;
    if (settings.resumeCountsAsWatched && (s.resume_time || 0) > 0) return false;
    return true;
  }

  function evaluate() {
    var id = currentSceneId();
    var key = id || "none";
    if (key === lastKey && id && cache[id] !== undefined) return;
    lastKey = key;
    if (!id) { setMarked(false); return; }
    if (cache[id] !== undefined) { setMarked(isUnwatched(cache[id])); return; }
    gql("query($ids:[ID!]){findScenes(ids:$ids){scenes{id play_count resume_time}}}", { ids: [id] })
      .then(function (d) {
        var s = (((d.findScenes || {}).scenes) || [])[0] || { play_count: 0, resume_time: 0 };
        cache[id] = s;
        if (currentSceneId() === id) setMarked(isUnwatched(s));
      })
      .catch(function () { /* 失敗時は触らない */ });
  }

  /// SPA 遷移（pushState/replaceState/popstate）でも評価する
  function hookHistory() {
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = history[m];
      history[m] = function () {
        var r = orig.apply(this, arguments);
        setTimeout(evaluate, 0);
        return r;
      };
    });
    window.addEventListener("popstate", function () { setTimeout(evaluate, 0); });
  }

  var t = null;
  new MutationObserver(function () {
    if (t) return;
    t = setTimeout(function () { t = null; evaluate(); }, 200);
  }).observe(document.body, { childList: true, subtree: true });

  /* ---------- settings page ----------
   * The setting labels and the plugin description above them come from the YAML,
   * which Stash serves as plain text: the plugin format has no localisation, and
   * there is no API for a plugin to register translations of its own. So they
   * are translated here (this plugin has no tasks, so there is nothing else).
   *
   *  - The rows are drawn by Stash's PluginSettings component, which is
   *    patchable: this plugin's props are handed on with the labels swapped,
   *    and every other plugin's are passed through untouched.
   *  - The description above the rows is not drawn from anything a plugin can
   *    reach, so it is corrected in the DOM.
   *  - The strings are a separate JSON, fetched from this plugin's own assets
   *    the first time a settings page is opened (the text in every language is
   *    many times the size of this file, and no other page shows it). */
  var SETTINGS_URL = "/plugin/" + PLUGIN_ID + "/assets/" + PLUGIN_ID + ".settings.json";
  var settingsText = null;    // strings in the UI language, once fetched
  var settingsWaiters = [];   // redraws waiting for the fetch
  var settingsAsked = false;
  var langReady = null;       // loadSettings() の完了（langCode 確定）を待つ

  function loadSettingsText() {
    if (settingsAsked) return;
    settingsAsked = true;
    Promise.all([
      langReady,
      fetch(SETTINGS_URL, { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; }),
    ])
      .then(function (res) {
        var table = res[1];
        if (!table) return;
        var code = (langCode || "en").toLowerCase();
        settingsText = table[code] || table[code.split("-")[0]] || table.en || null;
      })
      .catch(function () {}) // fetch 失敗時は英語のまま
      .then(function () {
        var waiting = settingsWaiters;
        settingsWaiters = [];
        waiting.forEach(function (fn) { try { fn(); } catch (e) {} });
      });
  }

  function say(key) {
    return (settingsText && settingsText[key]) || null;
  }

  (function patchSettings() {
    var api = window.PluginApi;
    // プラグイン API が無い古い Stash では設定画面は英語のまま
    if (!api || !api.patch || !api.patch.instead || !api.React) return;
    var React = api.React;

    // Stash の PluginSettings の代わりに描く（このプラグインのときだけ）。行は
    // Stash 本体のまま。文字列を取得し、届いたら再描画して、ラベルを差し替えて渡す。
    function UnwatchedDotSettings(props) {
      var redraw = React.useState(0)[1];
      var rows = (props.args[0] && props.args[0].settings) || [];

      React.useEffect(function () {
        if (settingsText) return;
        function onLoaded() { redraw(function (n) { return n + 1; }); }
        settingsWaiters.push(onLoaded);
        loadSettingsText();
        return function () {
          settingsWaiters = settingsWaiters.filter(function (fn) { return fn !== onLoaded; });
        };
      });

      // 行の上に出るプラグイン説明はページ自身が描くので DOM で直す。自分の行を
      // 起点に探すので他プラグインの説明は触らない。
      React.useEffect(function () {
        var text = say("plugin.description");
        if (!text || !rows.length) return;
        var row = document.getElementById("plugin-" + PLUGIN_ID + "-" + rows[0].name);
        var group = row && row.closest ? row.closest(".setting-group") : null;
        var sub = group ? group.querySelector(".setting .sub-heading") : null;
        if (sub && sub.textContent !== text) sub.textContent = text;
      });

      // mount ではなく呼び出すことで、渡された引数（後続 patch の next 含む）を保つ
      var args = props.args.slice();
      if (settingsText && rows.length) {
        args[0] = Object.assign({}, args[0], {
          settings: rows.map(function (s) {
            var name = say("setting." + s.name + ".name");
            var desc = say("setting." + s.name + ".description");
            if (!name && !desc) return s;
            return Object.assign({}, s, {
              display_name: name || s.display_name,
              description: desc || s.description,
            });
          }),
        });
      }
      return props.next.apply(null, args);
    }

    api.patch.instead("PluginSettings", function (props) {
      var args = Array.prototype.slice.call(arguments);
      var next = args.pop();
      if (!props || props.pluginID !== PLUGIN_ID) return next.apply(this, args);
      return React.createElement(UnwatchedDotSettings, { args: args, next: next });
    });
  })();

  hookHistory();
  langReady = loadSettings();
  langReady.then(loadBase).then(function (img) { baseImage = img; evaluate(); });
})();
