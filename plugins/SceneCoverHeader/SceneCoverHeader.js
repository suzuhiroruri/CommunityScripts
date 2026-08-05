/* =========================================================================
 * Scene Cover Header (Stash UI plugin).
 *
 * Puts the scene's cover art (the jacket) into the scene detail column of a
 * scene page: by default between the studio logo and the title, inside
 * .scene-header-container. The image is the one Stash already serves at
 * /scene/<id>/screenshot -- the same URL the player uses for its poster, so
 * showing it here costs no extra download.
 *
 * The React tree re-renders the header on navigation and on edits, so the
 * insertion is driven by a MutationObserver and is idempotent: an image that
 * is already in place for the current scene is left alone.
 * ========================================================================= */
(function () {
  "use strict";

  var PLUGIN_ID = "SceneCoverHeader";
  var CLASS = "scene-cover-header";

  // Settings, with their defaults until loadSettings() resolves.
  var placement = "studio"; // studio | title | off
  var maxHeight = 240;      // px, 0 = no limit
  var clickToOpen = true;

  var coverCache = {}; // scene id -> cover URL (with Stash's ?t cache buster)

  /* ---------- GraphQL ---------- */
  function gql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query: query, variables: variables || {} }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.data) || null; })
      .catch(function () { return null; });
  }

  function asBool(v, dflt) {
    if (v === true || v === false) return v;
    if (typeof v === "string") {
      var s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "no") return false;
    }
    return dflt;
  }

  function loadSettings() {
    return gql("{configuration{plugins}}").then(function (d) {
      var cfg = {};
      try { cfg = (d.configuration.plugins || {})[PLUGIN_ID] || {}; } catch (e) {}
      var p = String(cfg.placement || "").trim().toLowerCase();
      if (p === "studio" || p === "title" || p === "off") placement = p;
      var h = parseInt(cfg.maxHeight, 10);
      if (!isNaN(h) && h >= 0) maxHeight = h;
      clickToOpen = asBool(cfg.clickToOpen, true);
    });
  }

  /* ---------- cover URL ---------- */
  // Stash's own URL carries a ?t=<updated_at> cache buster, so a re-set cover
  // shows up immediately. Fall back to the bare path if the query fails.
  function coverURL(id) {
    if (coverCache[id]) return Promise.resolve(coverCache[id]);
    return gql("query($id:ID!){findScene(id:$id){paths{screenshot}}}", { id: id })
      .then(function (d) {
        var url;
        try { url = d.findScene.paths.screenshot; } catch (e) {}
        if (!url) url = "/scene/" + id + "/screenshot";
        coverCache[id] = url;
        return url;
      });
  }

  function sceneIdOf(path) {
    var m = /^\/scenes\/(\d+)(?:\/|$)/.exec(path || "");
    return m ? m[1] : null;
  }

  /* ---------- insertion ---------- */
  function build(id, url) {
    var el = document.createElement(clickToOpen ? "a" : "div");
    el.className = CLASS;
    el.setAttribute("data-scene-id", id);
    if (clickToOpen) {
      el.href = url;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
    }
    var img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    if (maxHeight > 0) img.style.maxHeight = maxHeight + "px";
    // A scene with no cover file still resolves, but a broken image would leave
    // an empty box -- drop the whole element in that case.
    img.onerror = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    el.appendChild(img);
    return el;
  }

  function place(container, el) {
    if (placement === "title") {
      container.appendChild(el); // after h3.scene-header
      return;
    }
    var logo = container.querySelector("h1.studio-logo, .studio-logo");
    if (logo && logo.parentNode === container) container.insertBefore(el, logo.nextSibling);
    else container.insertBefore(el, container.firstChild);
  }

  var pending = null; // scene id whose cover lookup is in flight

  function sync() {
    var id = sceneIdOf(window.location.pathname);
    var container = document.querySelector(".scene-header-container");

    if (!id || placement === "off" || !container) {
      var stale = document.querySelectorAll("." + CLASS);
      for (var i = 0; i < stale.length; i++) stale[i].remove();
      return;
    }

    var existing = container.querySelector("." + CLASS);
    if (existing) {
      if (existing.getAttribute("data-scene-id") === id) return; // already correct
      existing.remove();
    }
    if (pending === id) return;
    pending = id;
    coverURL(id).then(function (url) {
      pending = null;
      // The page may have moved on while the query was in flight.
      if (sceneIdOf(window.location.pathname) !== id) return;
      var c = document.querySelector(".scene-header-container");
      if (!c || c.querySelector("." + CLASS)) return;
      place(c, build(id, url));
    });
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; sync(); });
  }

  /* ---------- boot ---------- */
  // Navigating between scenes re-renders the header, so the observer alone
  // covers route changes -- no history patching needed.
  loadSettings().then(function () {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", schedule);
    schedule();
  });
})();
