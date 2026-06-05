const modePrompts = {
  "Quick Reflection": [
    "How would you describe your current state?",
    "What is one thing that affected your state today?"
  ],
  "Brief Reflection": [
    "What happened today?",
    "How did it affect your feeling or study state?",
    "What do you notice from this?"
  ],
  "Guided Reflection": [
    "What happened?",
    "Why did it affect you?",
    "What does it tell you about your current study-life pattern?",
    "What might you keep, change, or try next?"
  ]
};

const modeDescriptions = {
  "Quick Reflection": "A short, low-burden mode for high-pressure or low-energy days.",
  "Brief Reflection": "A medium-depth mode for connecting an event with feelings or study state.",
  "Guided Reflection": "A deeper mode for complex emotions, meaningful events, and future intentions."
};

let currentEntry = {};
let selectedMode = "";
const storageKey = "adaptive_journaling_entries_v1";
const metadataKey = "adaptive_journaling_metadata_v1";
const reviewKey = "adaptive_journaling_reviews_v1";
const visibilityKey = "adaptive_journaling_visibility_v1";

const participantKey = "adaptive_journaling_participant_id_v1";

// ---------------------------------------------------------------------------
// Participant identity
//
// No account or password. A participant types the ID you assigned them once;
// it is stored on THIS device/browser and reused on later days. Optionally you
// can restrict which IDs are accepted (prevents typos and accidental clashes).
// ---------------------------------------------------------------------------
const PARTICIPANT_CONFIG = {
  // Optional allowlist of the IDs you hand out. Leave as [] to accept any ID.
  // Example: allowedIds: ["P01", "P02", "P03", "P04", "P05"]
  allowedIds: []
};

function isAllowedParticipantId(id) {
  if (!PARTICIPANT_CONFIG.allowedIds || PARTICIPANT_CONFIG.allowedIds.length === 0) return true;
  return PARTICIPANT_CONFIG.allowedIds.includes(id);
}

// ---------------------------------------------------------------------------
// Researcher cloud sync (Google Apps Script -> Google Sheet)
//
// Only research METADATA is uploaded. Raw journal text (promptAnswers and the
// optional extra note) is NEVER placed in an upload payload and stays in this
// browser only. See GOOGLE_SHEETS_SETUP.md for how to create the endpoint.
// ---------------------------------------------------------------------------
const SHEETS_CONFIG = {
  // Paste your deployed Apps Script Web App URL between the quotes.
  // Leave empty ("") to keep the app fully local (CSV export still works).
  endpointUrl: "https://script.google.com/macros/s/AKfycbxF9Y9x3dil-zEgFhQpxpsPw0U94zEz7Mk55NtahsRGXwFhfWMxuuNYkB18DiLnFt3ewg/exec",
  // Optional shared secret. If set, it must match SHARED_SECRET in the Apps Script.
  sharedSecret: ""
};

const syncQueueKey = "adaptive_journaling_sync_queue_v1";

function isSyncConfigured() {
  return typeof SHEETS_CONFIG.endpointUrl === "string" && SHEETS_CONFIG.endpointUrl.trim() !== "";
}

function makeUploadId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Push a metadata record onto the durable upload queue and try to flush it.
// If the device is offline or the upload fails, the record stays queued and is
// retried on the next save or page load, so nothing is silently lost.
function enqueueUpload(type, record) {
  const queue = getStored(syncQueueKey);
  queue.push({
    uploadId: record.uploadId || makeUploadId(),
    type,
    record,
    attempts: 0
  });
  setStored(syncQueueKey, queue);
  flushSyncQueue();
}

async function postToSheet(item) {
  // text/plain keeps this a CORS "simple request" so the browser does not send
  // a preflight that Apps Script cannot answer.
  const payload = {
    type: item.type,
    uploadId: item.uploadId,
    secret: SHEETS_CONFIG.sharedSecret || "",
    record: item.record
  };
  const res = await fetch(SHEETS_CONFIG.endpointUrl.trim(), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => ({ ok: true }));
  if (data && data.ok === false) throw new Error(data.error || "Server rejected the record");
  return data;
}

let isFlushing = false;

async function flushSyncQueue() {
  updateSyncStatus();
  if (!isSyncConfigured() || isFlushing) return;
  if (getStored(syncQueueKey).length === 0) return;

  isFlushing = true;
  try {
    const queue = getStored(syncQueueKey);
    const stillPending = [];
    for (const item of queue) {
      try {
        await postToSheet(item);
      } catch (err) {
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = String(err && err.message ? err.message : err);
        stillPending.push(item);
      }
    }
    // Merge with anything queued while we were flushing.
    const queuedDuring = getStored(syncQueueKey).filter(
      q => !queue.some(orig => orig.uploadId === q.uploadId)
    );
    setStored(syncQueueKey, stillPending.concat(queuedDuring));
  } finally {
    isFlushing = false;
    updateSyncStatus();
  }
}

function updateSyncStatus() {
  const el = document.getElementById("syncStatus");
  if (!el) return;

  if (!isSyncConfigured()) {
    el.textContent = "Cloud sync is not configured. Metadata stays on this device; use the CSV export below to share it.";
    el.className = "muted sync-status sync-off";
    return;
  }

  const pending = getStored(syncQueueKey).length;
  if (pending === 0) {
    el.textContent = "✓ All research metadata on this device has been uploaded to the researcher’s secure Google Sheet.";
    el.className = "muted sync-status sync-ok";
  } else {
    el.textContent = `${pending} record(s) waiting to upload (saved safely on this device). They will retry automatically — or press “Retry upload now”.`;
    el.className = "muted sync-status sync-pending";
  }
}

function getParticipantId() {
  return localStorage.getItem(participantKey) || "";
}

function setParticipantId(value) {
  localStorage.setItem(participantKey, value);
}

function updateParticipantUI() {
  const participantId = getParticipantId();
  const hasId = !!participantId;
  const setupInput = document.getElementById("setupParticipantId");
  const currentText = document.getElementById("currentParticipantText");
  const checkinInput = document.getElementById("participantId");
  const saveBtn = document.getElementById("saveParticipantIdBtn");
  const resetBtn = document.getElementById("resetParticipantBtn");

  if (setupInput) {
    setupInput.value = participantId;
    // Once registered, lock the field so the device's identity cannot be
    // changed by accident. Use the reset button to deliberately change it.
    setupInput.readOnly = hasId;
    setupInput.disabled = hasId;
  }
  if (saveBtn) saveBtn.style.display = hasId ? "none" : "";
  if (resetBtn) resetBtn.style.display = hasId ? "" : "none";
  if (currentText) {
    currentText.textContent = hasId
      ? `✓ This device is set up for participant: ${participantId}`
      : "No participant ID has been saved on this device yet.";
  }
  if (checkinInput) { checkinInput.value = participantId; checkinInput.readOnly = true; }
}


function getStored(key) {
  return JSON.parse(localStorage.getItem(key) || "[]");
}

function setStored(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function showPage(pageId) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById(pageId).classList.add("active");

  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.page === pageId);
  });

  if (pageId === "history") loadHistory();
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if ((btn.dataset.page === "checkin" || btn.dataset.page === "history") && !getParticipantId()) {
      alert("Please set and save your participant ID on the Home page first.");
      showPage("home");
      return;
    }
    showPage(btn.dataset.page);
  });
});

document.getElementById("saveParticipantIdBtn").addEventListener("click", () => {
  if (getParticipantId()) {
    alert('This device is already set up for a participant ID. Use "Not you? Reset this device" if you really need to change it.');
    return;
  }
  const value = document.getElementById("setupParticipantId").value.trim();
  if (!value) {
    alert("Please enter a participant ID.");
    return;
  }
  if (!isAllowedParticipantId(value)) {
    alert("This participant ID is not recognised. Please enter exactly the ID the researcher gave you.");
    return;
  }
  setParticipantId(value);
  updateParticipantUI();
  alert(`This device is now set up for participant ${value}. Please use the same browser and device each day.`);
});

const resetParticipantBtn = document.getElementById("resetParticipantBtn");
if (resetParticipantBtn) {
  resetParticipantBtn.addEventListener("click", () => {
    const current = getParticipantId();
    const ok = confirm(
      `This device is set up for ${current}.\n\n` +
      `Resetting lets a different participant ID be entered on this device. ` +
      `The journal history for ${current} stays stored in this browser but is hidden until ${current} is entered again.\n\nContinue?`
    );
    if (!ok) return;
    localStorage.removeItem(participantKey);
    updateParticipantUI();
    showPage("home");
  });
}

function bindSlider(id, outputId) {
  const slider = document.getElementById(id);
  const output = document.getElementById(outputId);
  slider.addEventListener("input", () => output.textContent = slider.value);
}

["workload", "timePressure", "reflectiveEnergy", "emotionalComplexity"].forEach(id => {
  const out = id + "Val";
  bindSlider(id, out);
});

bindSlider("fitRating", "fitVal");
bindSlider("burdenRating", "burdenVal");
bindSlider("reflectiveValueRating", "reflectiveValueVal");

function recommendMode(workload, timePressure, reflectiveEnergy, emotionalComplexity, eventFlag) {
  if (reflectiveEnergy <= 2 || (workload >= 4 && timePressure >= 4)) {
    return "Quick Reflection";
  }
  if (emotionalComplexity >= 4 || eventFlag === "Yes") {
    return "Guided Reflection";
  }
  return "Brief Reflection";
}

function getEventFlag() {
  return document.querySelector("input[name='eventFlag']:checked").value;
}

document.getElementById("getModeBtn").addEventListener("click", () => {
  const participantId = document.getElementById("participantId").value.trim();
  if (!participantId) {
    alert("Please set and save your participant ID on the Home page first.");
    showPage("home");
    return;
  }

  const workload = Number(document.getElementById("workload").value);
  const timePressure = Number(document.getElementById("timePressure").value);
  const reflectiveEnergy = Number(document.getElementById("reflectiveEnergy").value);
  const emotionalComplexity = Number(document.getElementById("emotionalComplexity").value);
  const eventFlag = getEventFlag();

  const mood = document.getElementById("mood").value;
  const recommended = recommendMode(workload, timePressure, reflectiveEnergy, emotionalComplexity, eventFlag);

  currentEntry = {
    timestamp: new Date().toISOString(),
    entryId: String(Date.now()),
    participantId,
    moodLabel: mood,
    workload,
    timePressure,
    reflectiveEnergy,
    emotionalComplexity,
    eventFlag,
    eventKeyword: document.getElementById("eventKeyword").value.trim(),
    recommendedMode: recommended
  };

  selectedMode = recommended;
  renderModePage();
  showPage("mode");
});

function renderModePage() {
  document.getElementById("suggestedModeText").innerHTML =
    `Based on your check-in, today’s suggested mode is: <strong>${currentEntry.recommendedMode}</strong>`;
  document.getElementById("suggestedModeCaption").textContent = modeDescriptions[currentEntry.recommendedMode];

  const container = document.getElementById("modeOptions");
  container.innerHTML = "";

  Object.keys(modePrompts).forEach(mode => {
    const div = document.createElement("div");
    div.className = "mode-option" + (mode === selectedMode ? " selected" : "");
    div.innerHTML = `<h3>${mode}</h3><p>${modeDescriptions[mode]}</p>`;
    div.addEventListener("click", () => {
      selectedMode = mode;
      renderModePage();
    });
    container.appendChild(div);
  });
}

document.getElementById("continueJournalBtn").addEventListener("click", () => {
  currentEntry.selectedMode = selectedMode;
  currentEntry.acceptedRecommendation = selectedMode === currentEntry.recommendedMode;
  renderJournalPrompts();
  showPage("journal");
});

function renderJournalPrompts() {
  document.getElementById("journalModeText").innerHTML = `<strong>Mode:</strong> ${selectedMode}<br><span class="muted">${modeDescriptions[selectedMode]}</span>`;
  const container = document.getElementById("promptContainer");
  container.innerHTML = "";

  modePrompts[selectedMode].forEach((prompt, index) => {
    const label = document.createElement("label");
    label.textContent = `${index + 1}. ${prompt} *`;

    const textarea = document.createElement("textarea");
    textarea.id = `promptAnswer${index}`;
    textarea.dataset.prompt = prompt;

    label.appendChild(textarea);
    container.appendChild(label);
  });
}


function showCelebration(type = "entry") {
  const overlay = document.getElementById("celebrationOverlay");
  if (!overlay) return;

  overlay.innerHTML = "";

  const message = document.createElement("div");
  message.className = "celebration-message";
  message.textContent = type === "review" ? "Reflection saved ✨" : "Entry saved 🎈";
  overlay.appendChild(message);

  const items = type === "review"
    ? ["✨", "⭐", "🌟", "💫", "✨"]
    : ["🎈", "🎉", "✨", "🌈", "🎊"];

  for (let i = 0; i < 24; i++) {
    const item = document.createElement("div");
    item.className = "celebration-item";
    item.textContent = items[i % items.length];
    item.style.left = `${Math.random() * 100}%`;
    item.style.animationDelay = `${Math.random() * 0.5}s`;
    item.style.fontSize = `${24 + Math.random() * 18}px`;
    overlay.appendChild(item);
  }

  setTimeout(() => {
    overlay.innerHTML = "";
  }, 2600);
}


document.getElementById("saveEntryBtn").addEventListener("click", () => {
  const promptAnswers = {};
  let missing = false;

  document.querySelectorAll("#promptContainer textarea").forEach(textarea => {
    const answer = textarea.value.trim();
    if (!answer) missing = true;
    promptAnswers[textarea.dataset.prompt] = answer;
  });

  if (missing) {
    alert("Please answer all required prompt questions before saving.");
    return;
  }

  const extraNote = document.getElementById("extraNote").value.trim();
  const allText = Object.values(promptAnswers).join(" ") + " " + extraNote;
  const entryLength = allText.trim().split(/\s+/).filter(Boolean).length;

  const entry = {
    ...currentEntry,
    promptAnswers,
    optionalExtraNote: extraNote,
    fitRating: Number(document.getElementById("fitRating").value),
    burdenRating: Number(document.getElementById("burdenRating").value),
    reflectiveValueRating: Number(document.getElementById("reflectiveValueRating").value),
    openFeedback: document.getElementById("openFeedback").value.trim(),
    entryLength,
    hidden: false
  };

  const entries = getStored(storageKey);
  entries.push(entry);
  setStored(storageKey, entries);

  // Metadata only — note that promptAnswers and optionalExtraNote (the raw
  // journal text) are deliberately NOT included here, so they are never uploaded.
  const metaRecord = {
    uploadId: makeUploadId(),
    timestamp: entry.timestamp,
    entryId: entry.entryId,
    participantId: entry.participantId,
    moodLabel: entry.moodLabel,
    workload: entry.workload,
    timePressure: entry.timePressure,
    reflectiveEnergy: entry.reflectiveEnergy,
    emotionalComplexity: entry.emotionalComplexity,
    eventFlag: entry.eventFlag,
    eventKeyword: entry.eventKeyword,
    recommendedMode: entry.recommendedMode,
    selectedMode: entry.selectedMode,
    acceptedRecommendation: entry.acceptedRecommendation,
    fitRating: entry.fitRating,
    burdenRating: entry.burdenRating,
    reflectiveValueRating: entry.reflectiveValueRating,
    openFeedback: entry.openFeedback,
    entryLength: entry.entryLength
  };

  const metadata = getStored(metadataKey);
  metadata.push(metaRecord);
  setStored(metadataKey, metadata);
  enqueueUpload("dailyMetadata", metaRecord);

  showCelebration("entry");
  loadHistory();
  showPage("history");
});

function entrySummary(entry) {
  const keyword = entry.eventKeyword || "No keyword";
  return `${entry.moodLabel} | ${new Date(entry.timestamp).toLocaleString()} | ${entry.selectedMode} | ${keyword}`;
}

function loadHistory() {
  const participantId = getParticipantId();
  const entries = getStored(storageKey).filter(e => e.participantId === participantId);
  const list = document.getElementById("historyList");
  const select = document.getElementById("entryToRevisit");
  list.innerHTML = "";
  select.innerHTML = "";

  if (!participantId) {
    list.innerHTML = "<p>Please enter a participant ID.</p>";
    return;
  }

  if (entries.length === 0) {
    list.innerHTML = "<p>No saved entries found for this participant ID in this browser yet.</p>";
    document.getElementById("laterReflectionCard").style.display = "none";
    return;
  }

  document.getElementById("laterReflectionCard").style.display = "block";

  entries.slice().reverse().forEach(entry => {
    const div = document.createElement("div");
    div.className = "entry" + (entry.hidden ? " hidden" : "");

    if (entry.hidden) {
      div.innerHTML = `
        <div class="entry-summary-row">
          <h3>Hidden entry | ${new Date(entry.timestamp).toLocaleString()} | ${entry.moodLabel}</h3>
          <button class="small-button" data-action="unhide" data-id="${entry.entryId}">Unhide</button>
        </div>
        <p class="muted">This entry is hidden from full view. It is not deleted, so its metadata can still support the study.</p>
      `;
    } else {
      const answers = Object.entries(entry.promptAnswers).map(([prompt, answer]) => `
        <div class="entry-answer">
          <strong>${prompt}</strong>
          <p>${escapeHtml(answer)}</p>
        </div>
      `).join("");

      div.innerHTML = `
        <div class="entry-summary-row">
          <h3>${entrySummary(entry)}</h3>
          <button class="small-button" data-action="toggle-details" data-id="${entry.entryId}">View</button>
        </div>
        <div class="entry-details" id="entryDetails-${entry.entryId}">
          <p><strong>Date/time:</strong> ${new Date(entry.timestamp).toLocaleString()}</p>
          <p><strong>Mood:</strong> ${entry.moodLabel}</p>
          <p><strong>Keyword:</strong> ${entry.eventKeyword || "No keyword"}</p>
          <p><strong>Recommended mode:</strong> ${entry.recommendedMode}</p>
          <p><strong>Selected mode:</strong> ${entry.selectedMode}</p>
          <h4>Journal answers</h4>
          ${answers}
          ${entry.optionalExtraNote ? `<div class="entry-answer"><strong>Anything else recorded</strong><p>${escapeHtml(entry.optionalExtraNote)}</p></div>` : ""}
          <button class="small-button" data-action="hide" data-id="${entry.entryId}">Hide this entry</button>
          <p class="muted">Hiding keeps the entry from full view without deleting its study metadata.</p>
        </div>
      `;
    }

    list.appendChild(div);
  });

  list.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const entryId = btn.dataset.id;

      if (action === "hide") {
        toggleHidden(entryId, true);
      } else if (action === "unhide") {
        toggleHidden(entryId, false);
      } else if (action === "toggle-details") {
        const details = document.getElementById(`entryDetails-${entryId}`);
        if (details) {
          details.classList.toggle("open");
          btn.textContent = details.classList.contains("open") ? "Hide details" : "View";
        }
      }
    });
  });

  entries.filter(e => !e.hidden).forEach(entry => {
    const option = document.createElement("option");
    option.value = entry.entryId;
    option.textContent = entrySummary(entry);
    select.appendChild(option);
  });

  renderSelectedEntryPreview();
}

function toggleHidden(entryId, hidden) {
  const entries = getStored(storageKey);
  const entry = entries.find(e => e.entryId === entryId);
  if (entry) entry.hidden = hidden;
  setStored(storageKey, entries);

  const visibilityRecord = {
    uploadId: makeUploadId(),
    timestamp: new Date().toISOString(),
    participantId: entry ? entry.participantId : "",
    entryId,
    hidden,
    action: hidden ? "hide" : "unhide"
  };
  const visibility = getStored(visibilityKey);
  visibility.push(visibilityRecord);
  setStored(visibilityKey, visibility);
  enqueueUpload("visibilityLog", visibilityRecord);

  loadHistory();
}

document.getElementById("entryToRevisit").addEventListener("change", renderSelectedEntryPreview);

function renderSelectedEntryPreview() {
  const entryId = document.getElementById("entryToRevisit").value;
  const entry = getStored(storageKey).find(e => e.entryId === entryId);
  const preview = document.getElementById("selectedEntryPreview");

  if (!entry) {
    preview.innerHTML = "<p>No visible entry selected.</p>";
    return;
  }

  const answers = Object.entries(entry.promptAnswers).map(([prompt, answer]) => `
    <div class="entry-answer">
      <strong>${prompt}</strong>
      <p>${escapeHtml(answer)}</p>
    </div>
  `).join("");

  preview.innerHTML = `
    <p><strong>${entry.moodLabel}</strong> — ${new Date(entry.timestamp).toLocaleString()} — ${entry.selectedMode}</p>
    ${answers}
    ${entry.optionalExtraNote ? `<div class="entry-answer"><strong>Anything else recorded</strong><p>${escapeHtml(entry.optionalExtraNote)}</p></div>` : ""}
  `;

  renderReviewHistoryForSelected(entry.entryId);
}

function renderReviewHistoryForSelected(entryId) {
  const container = document.getElementById("reviewHistoryList");
  if (!container) return;

  const reviews = getStored(reviewKey).filter(r => r.reviewedEntryId === entryId);

  if (reviews.length === 0) {
    container.innerHTML = `
      <h3>Saved later reflections</h3>
      <p class="muted">No later reflection has been saved for this entry yet.</p>
    `;
    return;
  }

  const items = reviews
    .slice()
    .reverse()
    .map(review => {
      const reviewId = review.reviewId || review.timestamp;
      return `
        <div class="review-item compact" id="review-${reviewId}">
          <div class="review-summary-row">
            <p><strong>${new Date(review.timestamp).toLocaleString()}</strong> | ${escapeHtml(review.noticedPattern || "No pattern selected")}</p>
            <button class="small-button" data-review-action="toggle" data-review-id="${reviewId}">View</button>
          </div>

          <div class="review-details" id="reviewDetails-${reviewId}">
            <p><strong>New thoughts or insights:</strong> ${escapeHtml(review.newThoughtsOrInsights || "No text added")}</p>
            <p><strong>Small next step:</strong> ${escapeHtml(review.nextSmallStep || "No text added")}</p>

            <div class="review-actions">
              <button class="small-button" data-review-action="edit" data-review-id="${reviewId}">Edit</button>
              <button class="small-button" data-review-action="delete" data-review-id="${reviewId}">Delete</button>
            </div>

            <div class="edit-review-form" id="editReview-${reviewId}" style="display:none;">
              <label>Pattern noticed
                <select id="editPattern-${reviewId}">
                  <option ${review.noticedPattern === "My workload has been high" ? "selected" : ""}>My workload has been high</option>
                  <option ${review.noticedPattern === "My emotions changed a lot" ? "selected" : ""}>My emotions changed a lot</option>
                  <option ${review.noticedPattern === "One topic keeps appearing" ? "selected" : ""}>One topic keeps appearing</option>
                  <option ${review.noticedPattern === "I handled something better than expected" ? "selected" : ""}>I handled something better than expected</option>
                  <option ${review.noticedPattern === "I am not sure yet" ? "selected" : ""}>I am not sure yet</option>
                  <option ${review.noticedPattern === "Other" ? "selected" : ""}>Other</option>
                </select>
              </label>
              <label>New thoughts or insights
                <textarea id="editInsights-${reviewId}">${escapeHtml(review.newThoughtsOrInsights || "")}</textarea>
              </label>
              <label>Small next step
                <textarea id="editNextStep-${reviewId}">${escapeHtml(review.nextSmallStep || "")}</textarea>
              </label>
              <button class="small-button" data-review-action="save-edit" data-review-id="${reviewId}">Save changes</button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `
    <h3>Saved later reflections</h3>
    ${items}
  `;

  container.querySelectorAll("button[data-review-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      handleReviewAction(btn.dataset.reviewAction, btn.dataset.reviewId, entryId);
    });
  });
}

function handleReviewAction(action, reviewId, entryId) {
  const details = document.getElementById(`reviewDetails-${reviewId}`);
  const editForm = document.getElementById(`editReview-${reviewId}`);

  if (action === "toggle") {
    if (details) {
      details.classList.toggle("open");
      const toggleButton = document.querySelector(`button[data-review-action="toggle"][data-review-id="${reviewId}"]`);
      if (toggleButton) toggleButton.textContent = details.classList.contains("open") ? "Hide" : "View";
    }
    return;
  }

  if (action === "edit") {
    if (editForm) {
      editForm.style.display = editForm.style.display === "none" ? "block" : "none";
    }
    return;
  }

  if (action === "delete") {
    const confirmed = confirm("Delete this saved later reflection?");
    if (!confirmed) return;

    const existing = getStored(reviewKey).find(r => (r.reviewId || r.timestamp) === reviewId);
    const reviews = getStored(reviewKey).filter(r => (r.reviewId || r.timestamp) !== reviewId);
    setStored(reviewKey, reviews);
    enqueueUpload("reviewReflection", {
      uploadId: makeUploadId(),
      action: "delete",
      reviewId,
      participantId: existing ? existing.participantId : getParticipantId(),
      reviewedEntryId: entryId,
      timestamp: new Date().toISOString()
    });
    renderReviewHistoryForSelected(entryId);
    return;
  }

  if (action === "save-edit") {
    const reviews = getStored(reviewKey);
    const review = reviews.find(r => (r.reviewId || r.timestamp) === reviewId);
    if (!review) return;

    review.noticedPattern = document.getElementById(`editPattern-${reviewId}`).value;
    review.newThoughtsOrInsights = document.getElementById(`editInsights-${reviewId}`).value.trim();
    review.nextSmallStep = document.getElementById(`editNextStep-${reviewId}`).value.trim();
    review.lastEditedAt = new Date().toISOString();

    setStored(reviewKey, reviews);
    enqueueUpload("reviewReflection", { uploadId: makeUploadId(), action: "edit", ...review });
    renderReviewHistoryForSelected(entryId);
    return;
  }
}

document.getElementById("saveReviewBtn").addEventListener("click", () => {
  const entryId = document.getElementById("entryToRevisit").value;
  const entry = getStored(storageKey).find(e => e.entryId === entryId);
  if (!entry) {
    alert("Please select a visible entry to revisit.");
    return;
  }

  const reviewRecord = {
    reviewId: String(Date.now()),
    timestamp: new Date().toISOString(),
    participantId: entry.participantId,
    reviewedEntryId: entry.entryId,
    reviewedEntryTime: entry.timestamp,
    noticedPattern: document.getElementById("noticedPattern").value,
    newThoughtsOrInsights: document.getElementById("newInsights").value.trim(),
    nextSmallStep: document.getElementById("nextStep").value.trim()
  };

  const reviews = getStored(reviewKey);
  reviews.push(reviewRecord);
  setStored(reviewKey, reviews);
  enqueueUpload("reviewReflection", { uploadId: makeUploadId(), action: "create", ...reviewRecord });
  showCelebration("review");
  renderReviewHistoryForSelected(entry.entryId);
});

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toCSV(rows) {
  if (!rows || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csvRows = [headers.join(",")];
  rows.forEach(row => {
    csvRows.push(headers.map(h => escape(row[h])).join(","));
  });
  return csvRows.join("\n");
}

function downloadCSV(filename, rows) {
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

function currentParticipantRows(rows, participantField = "participantId") {
  const participantId = getParticipantId();
  return rows.filter(row => row[participantField] === participantId);
}

document.getElementById("downloadMyMetadataBtn").addEventListener("click", () => {
  const rows = currentParticipantRows(getStored(metadataKey));
  downloadCSV(`daily_metadata_${getParticipantId()}.csv`, rows);
});

document.getElementById("downloadMyReviewsBtn").addEventListener("click", () => {
  const rows = currentParticipantRows(getStored(reviewKey));
  downloadCSV(`review_reflections_${getParticipantId()}.csv`, rows);
});

document.getElementById("downloadMyVisibilityBtn").addEventListener("click", () => {
  const rows = currentParticipantRows(getStored(visibilityKey));
  downloadCSV(`entry_visibility_log_${getParticipantId()}.csv`, rows);
});

const retrySyncBtn = document.getElementById("retrySyncBtn");
if (retrySyncBtn) {
  retrySyncBtn.addEventListener("click", () => flushSyncQueue());
}

// Retry queued uploads when the browser regains connectivity.
window.addEventListener("online", () => flushSyncQueue());

// Initial state
document.getElementById("laterReflectionCard").style.display = "none";
updateParticipantUI();
updateSyncStatus();
flushSyncQueue();
showPage("home");
