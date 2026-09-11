  /* ================= teleprompter ================= */

  function normalizeWord(w) {
    return String(w || "").toLowerCase().replace(/[^a-z0-9']/g, "");
  }

  /* split text nodes into <span class="w"> per word, preserving surrounding
     tags (strong/em/u/mark/a) so formatting survives word-wrapping */
  function wrapWordsForPrompter(node) {
    var kids = Array.prototype.slice.call(node.childNodes);
    kids.forEach(function (child) {
      if (child.nodeType === 3) {
        var parts = child.nodeValue.split(/(\s+)/);
        var frag = document.createDocumentFragment();
        parts.forEach(function (part) {
          if (part === "") return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
          var span = document.createElement("span");
          span.className = "w";
          span.textContent = part;
          frag.appendChild(span);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === 1) {
        if (child.tagName === "BR") return;
        wrapWordsForPrompter(child);
      }
    });
  }

  function tokenizeForPrompter(html) {
    var container = inertBody(sanitizeHtml(html));
    wrapWordsForPrompter(container);
    return container.innerHTML;
  }

  /* A trailing ., !, or ? (optionally tucked inside a closing quote/paren)
     reads as a finished thought — that row gets its own paragraph, with the
     usual breathing room before the next. Anything else (a trailing comma,
     or no punctuation at all — a sentence split across rows for editing
     convenience) flows straight into the next row instead, with no gap. */
  var SENTENCE_END_RE = /[.!?]["'’”)\]]*$/;

  function buildPrompterContent() {
    /* On day two you only want what's left. Filtering here rather than
       hiding after the fact keeps the word index — and so voice follow —
       lined up with what is actually on screen. */
    var source = prompterSkipShot
      ? state.rows.filter(function (row) { return row.status !== "shot"; })
      : state.rows;
    var lineHtml = source
      .map(function (row) { return (row.audioText || "").replace(/^(\s|<br\s*\/?>)+|(\s|<br\s*\/?>)+$/g, ""); })
      .filter(function (html) { return html.trim(); });

    var paragraphs = [];
    lineHtml.forEach(function (html, i) {
      var prevEndsSentence = i === 0 || SENTENCE_END_RE.test(htmlToPlainText(lineHtml[i - 1]).trim());
      if (prevEndsSentence) paragraphs.push(html);
      else paragraphs[paragraphs.length - 1] += " " + html;
    });

    var content = document.getElementById("prompter-content");
    if (!paragraphs.length) {
      content.innerHTML = '<div class="prompter-empty">' + (prompterSkipShot
        ? "Every scene is marked Shot — switch off Skip shot to read them again."
        : "Nothing to read yet — add some audio text first.") + '</div>';
      promptWords = [];
    } else {
      content.innerHTML = paragraphs.map(function (html) {
        return '<div class="prompter-line">' + tokenizeForPrompter(html) + '</div>';
      }).join("");
      promptWords = Array.prototype.map.call(content.querySelectorAll(".w"), function (el) {
        return { el: el, norm: normalizeWord(el.textContent) };
      });
    }
    speakable = [];
    speakNorms = [];
    promptWords.forEach(function (w, i) {
      if (!w.norm) return;
      speakable.push(i);
      speakNorms.push(w.norm);
    });
    wordCursor = -1;
    speakCursor = -1;
  }

  /* A phone's screen dims and locks mid-read without this — fatal for a
     teleprompter. Best-effort: unsupported browsers just don't get it, and
     the OS revokes it on tab switch, so it is re-acquired on return. */
  var prompterWakeLock = null;
  /* Bumped on every acquire/release so a request's resolution can tell
     whether it is still the one that matters. request() is fire-and-forget
     with no cancellation token: the prompter can close (or visibilitychange
     can fire another acquire, which it does every time the tab regains
     focus while open) before it resolves, and releaseWakeLock() can only
     ever act on whatever is CURRENTLY in prompterWakeLock — a lock that
     lands after the fact, or a lock superseded by a newer request, used to
     just get silently stored over top with nothing left to release it,
     keeping the screen awake indefinitely. */
  var wakeLockGen = 0;

  function acquireWakeLock() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    var gen = ++wakeLockGen;
    navigator.wakeLock.request("screen").then(function (lock) {
      if (gen !== wakeLockGen || !prompterOpen) { lock.release().catch(function () {}); return; }
      prompterWakeLock = lock;
    }).catch(function () { /* denied (low battery etc.) — nothing to do */ });
  }

  function releaseWakeLock() {
    wakeLockGen++;
    if (prompterWakeLock) {
      prompterWakeLock.release().catch(function () {});
      prompterWakeLock = null;
    }
  }

  function openPrompter() {
    buildPrompterContent();
    var el = document.getElementById("prompter");
    el.hidden = false;
    prompterOpen = true;
    document.getElementById("prompter-scroll").scrollTop = 0;
    setPrompterPlaying(false);
    applyPrompterSize();
    updateVoiceAvailability();
    acquireWakeLock();
  }

  function closePrompter() {
    setPrompterPlaying(false);
    stopVoiceFollow();
    document.getElementById("prompter").hidden = true;
    prompterOpen = false;
    releaseWakeLock();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
    }
  }

  function setPrompterPlaying(on) {
    if (on && voiceFollowActive) stopVoiceFollow();
    prompterPlaying = on;
    var btn = document.getElementById("pp-play");
    btn.textContent = on ? "❚❚ Pause" : "▶ Play";
    btn.classList.toggle("is-active", on);
    if (on) {
      prompterLastTs = null;
      prompterRAF = requestAnimationFrame(prompterTick);
    } else if (prompterRAF) {
      cancelAnimationFrame(prompterRAF);
      prompterRAF = null;
    }
  }

  function prompterTick(ts) {
    var scroller = document.getElementById("prompter-scroll");
    if (prompterLastTs == null) prompterLastTs = ts;
    var dt = (ts - prompterLastTs) / 1000;
    prompterLastTs = ts;
    scroller.scrollTop += prompterSpeed * dt;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      setPrompterPlaying(false);
      return;
    }
    prompterRAF = requestAnimationFrame(prompterTick);
  }

  function applyPrompterSize() {
    var size = document.getElementById("pp-size").value;
    document.getElementById("prompter-content").style.fontSize = size + "px";
  }

  /* ---------- voice follow ---------- */

  function setVoiceStatus(msg, kind) {
    var el = document.getElementById("pp-voice-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "pp-voice-status" + (kind ? " " + kind : "");
  }

  function updateVoiceAvailability() {
    var btn = document.getElementById("pp-voice");
    if (!btn) return;
    /* The Web Speech API's constructor exists in Electron's Chromium, but
       recognition itself fails immediately with a 'network' error — Google's
       speech backend that powers it is not reachable from inside Electron
       the way it is from an actual Chrome/Edge install. Adam wants this
       fixed properly after the desktop conversion lands, not patched around
       here; for now this is a known, explained unavailability rather than a
       button that looks live and then fails on click. */
    if (DESKTOP) {
      btn.disabled = true;
      setVoiceStatus("Follow My Voice isn't available in the desktop app yet — it's coming in an update. It still works in Chrome or Edge.", "");
    } else if (!SpeechRecognitionCtor) {
      btn.disabled = true;
      setVoiceStatus("Voice follow needs Chrome or Edge.", "");
    } else if (!window.isSecureContext) {
      /* The API is right here — the browser just won't hand a microphone to
         a page opened straight off disk as file://. Saying "needs Chrome"
         here sends people to reinstall a browser they're already using;
         what actually fixes it is serving the page, which start.bat does. */
      btn.disabled = true;
      setVoiceStatus("Voice follow needs the app served over http:// — start it with start.bat.", "");
    } else {
      btn.disabled = false;
      if (!voiceFollowActive) setVoiceStatus("", "");
    }
  }

  function updateVoiceButtonUI() {
    var btn = document.getElementById("pp-voice");
    if (!btn) return;
    btn.classList.toggle("is-active", voiceFollowActive);
    btn.textContent = voiceFollowActive ? "Stop Following" : "Follow My Voice";
  }

  function applySpokenUpTo(idx) {
    for (var i = 0; i < promptWords.length; i++) {
      var el = promptWords[i].el;
      el.classList.toggle("spoken", i < idx);
      el.classList.toggle("current-word", i === idx);
    }
  }

  function clearSpokenHighlights() {
    promptWords.forEach(function (w) {
      w.el.classList.remove("spoken");
      w.el.classList.remove("current-word");
    });
  }

  function scrollWordIntoView(idx) {
    var w = promptWords[idx];
    if (!w) return;
    w.el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /* find where in the script the tail of what was just heard best lines up:
     for each candidate end position, count how many words match walking
     backward — rewards a run of consecutive matches near the speaker's
     actual position instead of one lucky common word */
  function findBestMatch(recentWords, scriptNorms, searchStart, searchEnd) {
    var n = recentWords.length;
    var bestScore = 0, bestIndex = -1;
    for (var end = searchStart; end <= searchEnd; end++) {
      var score = 0;
      for (var k = 1; k <= n && (end - k + 1) >= 0; k++) {
        if (scriptNorms[end - k + 1] === recentWords[n - k]) score++;
        else break;
      }
      if (score > bestScore) { bestScore = score; bestIndex = end; }
    }
    return { index: bestIndex, score: bestScore };
  }

  function onSpeechTranscript() {
    var combined = (finalTranscript + " " + interimTranscript).trim();
    var words = combined.split(/\s+/).map(normalizeWord).filter(Boolean);
    var recent = words.slice(-8);
    if (!recent.length || !speakNorms.length) return;

    /* Look a little way behind as well as ahead. Ahead covers a skipped or
       misheard phrase; behind is what lets a re-read ("sorry, again from
       the top of that line") re-sync instead of leaving the prompter
       stranded further down the page. */
    var searchStart = Math.max(0, speakCursor - 40);
    var searchEnd = Math.min(speakNorms.length - 1, speakCursor + 80);
    var best = findBestMatch(recent, speakNorms, searchStart, searchEnd);

    /* Going backwards needs a longer run of matching words than going
       forwards: one common word in a re-read shouldn't yank the reader back
       up the script, but two words is plenty to confirm normal progress. */
    if (best.index !== -1 && best.index !== speakCursor &&
        best.score >= (best.index > speakCursor ? 2 : 3)) {
      speakCursor = best.index;
      wordCursor = speakable[speakCursor];
      applySpokenUpTo(wordCursor);
      scrollWordIntoView(wordCursor);
    }

    /* Only the last handful of words are ever matched against, so the rest
       is dead weight that would otherwise grow for the whole read. */
    if (finalTranscript.length > 4000) finalTranscript = finalTranscript.slice(-1200);

    if (speakCursor >= speakNorms.length - 1) {
      setVoiceStatus("Reached the end", "listening");
    } else if (voiceFollowActive) {
      setVoiceStatus("Listening — following along", "listening");
    }
  }

  function releaseVoiceStream() {
    if (!voiceStream) return;
    try { voiceStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    voiceStream = null;
  }

  async function startVoiceFollow() {
    if (DESKTOP || !SpeechRecognitionCtor) return;
    /* recognition.start() is async and voiceFollowActive only flips in onstart,
       so without this a second click builds a second recognizer and orphans the
       first — an invisible live microphone session. */
    if (voiceFollowActive || voiceStarting) return;
    if (!speakNorms.length) {
      setVoiceStatus("Nothing to read yet.", "error");
      return;
    }
    voiceStarting = true;
    var mySession = ++voiceSession;
    setPrompterPlaying(false);
    finalTranscript = "";
    interimTranscript = "";
    wordCursor = -1;
    speakCursor = -1;
    voiceRestarts = 0;
    clearSpokenHighlights();

    /* Take the microphone once, up front, on the click that asked for it —
       and keep it (see voiceStream). Without this the browser re-prompts
       every time Chrome's own ~60-second session limit expires and we
       restart, which makes a long read unusable. Doing it here also lets us
       tell a refusal apart from a missing device, which the recognizer's own
       error reporting blurs together. */
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      setVoiceStatus("Asking for the microphone…", "");
      try {
        voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        voiceStarting = false;
        var name = err && err.name;
        setVoiceStatus(
          name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "No microphone was found."
            : "Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.",
          "error");
        return;
      }
      /* stopped while the permission prompt was still up */
      if (mySession !== voiceSession) { releaseVoiceStream(); voiceStarting = false; return; }
    }

    try {
      recognition = new SpeechRecognitionCtor();
    } catch (e) {
      voiceStarting = false;
      releaseVoiceStream();
      setVoiceStatus("Could not start speech recognition.", "error");
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = function () {
      voiceStarting = false;
      voiceFollowActive = true;
      updateVoiceButtonUI();
      setVoiceStatus("Listening…", "listening");
    };
    recognition.onresult = function (e) {
      var finalChunk = "", interimChunk = "";
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var r = e.results[i];
        if (r.isFinal) finalChunk += r[0].transcript + " ";
        else interimChunk += r[0].transcript + " ";
      }
      if (finalChunk) finalTranscript += finalChunk;
      interimTranscript = interimChunk;
      voiceRestarts = 0; /* hearing something is the only real proof it's healthy */
      onSpeechTranscript();
    };
    recognition.onerror = function (e) {
      voiceStarting = false;
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setVoiceStatus("Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.", "error");
        voiceFollowActive = false;
      } else if (e.error === "audio-capture") {
        setVoiceStatus("No microphone was found.", "error");
        voiceFollowActive = false;
      } else if (e.error === "network") {
        setVoiceStatus("Speech recognition needs an internet connection.", "error");
      } else {
        setVoiceStatus("Voice follow hit an error (" + e.error + ").", "error");
      }
      updateVoiceButtonUI();
    };
    /* Chrome ends a continuous session on its own every so often — after a
       silence, and after any transient error — so following someone through
       a long read means restarting it. Backing off stops that turning into a
       tight restart loop (and a stuttering mic indicator) when whatever
       ended it isn't going to clear on its own. */
    recognition.onend = function () {
      /* Not following any more — either stopped, or onerror gave up. This is
         the one place every such path passes through, so it is where the
         microphone gets handed back. */
      if (mySession !== voiceSession || !voiceFollowActive) {
        if (mySession === voiceSession) releaseVoiceStream();
        updateVoiceButtonUI();
        return;
      }
      voiceRestarts++;
      if (voiceRestarts > 40) {
        voiceFollowActive = false;
        releaseVoiceStream();
        updateVoiceButtonUI();
        setVoiceStatus("Voice follow kept dropping out — stopped.", "error");
        return;
      }
      setTimeout(function () {
        if (mySession !== voiceSession || !voiceFollowActive || !recognition) return;
        try { recognition.start(); }
        catch (e) {
          /* start() throwing synchronously (Chrome's "recognition has
             already started" when it hasn't fully torn down the previous
             session yet) means no further "end" event will ever fire for
             this attempt — this is a dead end, not just a stopped follow.
             Release the mic now, or it stays open (and the leaked
             `recognition` reference blocks a later manual restart from
             ever cleaning it up) with the UI showing "stopped". */
          voiceFollowActive = false;
          recognition = null;
          releaseVoiceStream();
          updateVoiceButtonUI();
        }
      }, Math.min(2000, 150 * voiceRestarts));
    };
    try {
      recognition.start();
    } catch (e) {
      voiceStarting = false;
      releaseVoiceStream();
      setVoiceStatus("Could not start speech recognition.", "error");
    }
  }

  function stopVoiceFollow() {
    var wasActive = voiceFollowActive;
    voiceSession++; /* strands any restart already queued by the old session */
    voiceFollowActive = false;
    voiceStarting = false;
    if (recognition) {
      /* drop onresult too — Chrome flushes in-flight results after stop() and
         a stale one would move the prompter after a restart */
      try { recognition.onend = null; recognition.onresult = null; recognition.stop(); } catch (e) {}
      recognition = null;
    }
    /* hand the microphone back the moment following stops, so the browser's
       recording indicator reflects what is actually happening */
    releaseVoiceStream();
    updateVoiceButtonUI();
    if (wasActive) setVoiceStatus("", "");
  }

  /* Shared by every panel that renders tagEntityHtml() cards. The card's own
     buttons (status pill, expand, rename, remove/delete) are all data-action
     and already work from any container through onRootClick — this wires
     the handful of non-click events the card also needs: Enter/Escape in
     the rename and add-person inputs, the owner <select>, and the notes
     textarea. Bulk selection and its bar are production-panel-only extras,
     layered on separately where each panel is wired in init(). */
  function wireTagEntityContainer(id) {
    var el = document.getElementById(id);
    el.addEventListener("click", onRootClick);
    el.addEventListener("keydown", function (e) {
      if (!e.target.classList) return;
      if (e.target.classList.contains("tag-rename-input")) {
        if (e.key === "Enter") { e.preventDefault(); saveTagRename(e.target.getAttribute("data-key")); }
        else if (e.key === "Escape") { e.preventDefault(); tagRenaming = null; renderProduction(); }
        return;
      }
      if (e.target.classList.contains("tag-person-input")) {
        if (e.key === "Enter") { e.preventDefault(); addPersonForTag(e.target.getAttribute("data-key")); }
        else if (e.key === "Escape") { e.preventDefault(); tagAddingPersonFor = null; renderProduction(); }
      }
    });
    el.addEventListener("change", function (e) {
      if (e.target.classList && e.target.classList.contains("tag-owner-select")) {
        setTagOwner(e.target.getAttribute("data-key"), e.target.value);
      }
    });
    el.addEventListener("input", function (e) {
      if (e.target.classList && e.target.classList.contains("tag-notes-input")) {
        setTagNotes(e.target.getAttribute("data-key"), e.target.value);
      }
    });
    /* notes save continuously as you type (see setTagNotes); the autosave is
       held until you leave the box so it isn't queued on every keystroke */
    el.addEventListener("focusout", function (e) {
      if (e.target.classList && e.target.classList.contains("tag-notes-input")) queueAutoSave();
    });
  }
