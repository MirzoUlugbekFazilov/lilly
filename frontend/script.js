// Medicine Tracker - frontend script.
//
// The backend API runs at BASE_URL (default http://localhost:8000).
//
// Core task 1: fetch /medicines and render it without crashing on bad records.
// Core task 2: fetch /medicines/unreliable with a small number of retries and a
//   useful error message when we give up.
// Stretch: call the average-price endpoint added in backend/main.py.

const BASE_URL = "http://localhost:8000";

// Retry policy for the unreliable endpoint. One initial attempt plus these
// delays, so 4 attempts total spread over ~3 seconds. Short enough that the
// user is not left waiting, gentle enough that we are not hammering the server.
const RETRY_DELAYS_MS = [400, 900, 1800];

// A request that never comes back is a failure too - don't hang forever.
const REQUEST_TIMEOUT_MS = 5000;

// Placeholders for the bad data in data.json.
const UNKNOWN_NAME = "Unknown medicine";
const MISSING_PRICE = "No price given";

// DOM elements (already present in index.html - no layout work needed).
const resultsEl = document.getElementById("results");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");
const summaryEl = document.getElementById("summary");
const buttons = Array.from(document.querySelectorAll(".controls button"));

// ---- Small UI helpers ----

function showLoading(message) {
    loadingEl.textContent = message;
    loadingEl.hidden = false;
}

function hideLoading() {
    loadingEl.hidden = true;
    loadingEl.textContent = "";
}

function showError(lines) {
    // Each line is plain text, set via textContent so odd data can never
    // inject markup.
    errorEl.replaceChildren();
    for (const line of lines) {
        const p = document.createElement("p");
        p.textContent = line;
        errorEl.appendChild(p);
    }
    errorEl.hidden = false;
}

function clearError() {
    errorEl.hidden = true;
    errorEl.replaceChildren();
}

function setSummary(text) {
    if (!summaryEl) return;
    summaryEl.textContent = text;
    summaryEl.hidden = !text;
}

// Stops double-clicks firing overlapping request chains.
function setBusy(isBusy) {
    for (const button of buttons) {
        button.disabled = isBusy;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Data cleaning ----
//
// The API is not trusted: any field may be null, missing or the wrong type.
// These two functions turn one raw field into { text, ok } so that rendering
// never has to think about it, and never throws.

function cleanName(raw) {
    if (typeof raw !== "string") {
        // Covers null, undefined (missing key) and any non-string type.
        return { text: UNKNOWN_NAME, ok: false };
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
        return { text: UNKNOWN_NAME, ok: false };
    }
    return { text: trimmed, ok: true };
}

function cleanPrice(raw) {
    if (raw === null || raw === undefined) {
        return { text: MISSING_PRICE, ok: false, value: null };
    }

    if (typeof raw === "number") {
        // Rules out NaN and Infinity, which survive JSON round-trips via
        // hand-edited data less often but are cheap to guard against.
        if (!Number.isFinite(raw)) {
            return { text: "Invalid price", ok: false, value: null };
        }
        return { text: formatPrice(raw), ok: true, value: raw };
    }

    if (typeof raw === "string") {
        const trimmed = raw.trim();
        const parsed = trimmed === "" ? NaN : Number(trimmed);
        if (Number.isFinite(parsed)) {
            // data.json has "6.99" as a string. It is clearly a price, so show
            // it, but flag it so the data problem stays visible.
            return { text: `${formatPrice(parsed)} (given as text)`, ok: false, value: parsed };
        }
        return { text: `Invalid price: "${trimmed}"`, ok: false, value: null };
    }

    return { text: "Invalid price", ok: false, value: null };
}

function formatPrice(value) {
    return `£${value.toFixed(2)}`;
}

// ---- Core task 1 ----

/**
 * Fetch the list of medicines from /medicines.
 * Returns the medicines array. Throws on network/HTTP/shape problems so the
 * caller can decide how to show them.
 */
async function fetchMedicines() {
    const payload = await getJson(`${BASE_URL}/medicines`);
    return extractMedicines(payload);
}

/**
 * The endpoint is documented as returning { medicines: [...] }, but tolerate a
 * bare array and treat anything else as an error rather than rendering nothing.
 */
function extractMedicines(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.medicines)) return payload.medicines;
    throw new Error("The response did not contain a list of medicines.");
}

/**
 * Render the medicines into #results. Built with createElement/textContent
 * rather than an innerHTML string, so a record cannot break the table or
 * inject markup.
 */
function renderMedicines(medicines) {
    resultsEl.replaceChildren();

    if (medicines.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "No medicines were returned.";
        resultsEl.appendChild(empty);
        setSummary("");
        return;
    }

    const table = document.createElement("table");

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["#", "Name", "Price"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement("tbody");
    let badRecords = 0;

    medicines.forEach((record, index) => {
        // A record itself may not be an object - cleanName/cleanPrice handle
        // the undefined fields that fall out of this.
        const safe = record && typeof record === "object" ? record : {};
        const name = cleanName(safe.name);
        const price = cleanPrice(safe.price);
        if (!name.ok || !price.ok) badRecords += 1;

        const row = document.createElement("tr");

        const indexCell = document.createElement("td");
        indexCell.textContent = String(index + 1);
        row.appendChild(indexCell);

        const nameCell = document.createElement("td");
        nameCell.textContent = name.text;
        if (!name.ok) nameCell.classList.add("invalid");
        row.appendChild(nameCell);

        const priceCell = document.createElement("td");
        priceCell.textContent = price.text;
        if (!price.ok) priceCell.classList.add("invalid");
        row.appendChild(priceCell);

        body.appendChild(row);
    });

    table.appendChild(body);
    resultsEl.appendChild(table);

    setSummary(
        badRecords === 0
            ? `${medicines.length} medicines, no data problems found.`
            : `${medicines.length} medicines, ${badRecords} with missing or invalid data (shown in red).`
    );
}

// ---- Core task 2 ----

/**
 * Fetch from /medicines/unreliable, retrying a few times with a short backoff.
 * Only retryable failures (network errors, timeouts, 5xx, 429) are retried -
 * retrying a 404 would just be noise. Gives up cleanly after RETRY_DELAYS_MS
 * is exhausted and explains what happened in #error.
 */
async function fetchUnreliable() {
    const totalAttempts = RETRY_DELAYS_MS.length + 1;
    const startedAt = Date.now();
    let lastError = null;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        attemptsMade = attempt;
        showLoading(
            attempt === 1
                ? "Loading from the unreliable source..."
                : `Retrying the unreliable source (attempt ${attempt} of ${totalAttempts})...`
        );

        try {
            const payload = await getJson(`${BASE_URL}/medicines/unreliable`);
            const medicines = extractMedicines(payload);
            renderMedicines(medicines);
            clearError();
            if (attempt > 1) {
                // Worth saying: the data on screen is good, but the source is flaky.
                showError([
                    `Loaded successfully on attempt ${attempt} of ${totalAttempts}.`,
                    `The data below is up to date. Earlier attempts failed: ${lastError.message}`,
                ]);
                errorEl.classList.add("warning");
            }
            return medicines;
        } catch (error) {
            lastError = error;

            if (!error.retryable) break;          // No point trying again.
            if (attempt === totalAttempts) break; // Out of attempts.

            await sleep(RETRY_DELAYS_MS[attempt - 1]);
        }
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    showError([
        "Could not load medicines from the unreliable source.",
        `Tried ${attemptsMade} time${attemptsMade === 1 ? "" : "s"} over ${seconds}s. Last failure: ${lastError.message}`,
        adviceFor(lastError),
    ]);
    throw lastError;
}

// ---- Shared fetch helper ----

/**
 * One GET returning parsed JSON. Everything that can go wrong is turned into an
 * Error with a readable message and a `retryable` flag for the retry loop:
 *   - network/CORS failure or timeout -> retryable
 *   - 5xx or 429                      -> retryable
 *   - other 4xx or unparseable JSON   -> not retryable
 */
async function getJson(url) {
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
        const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
        throw makeError(
            timedOut
                ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
                : "could not reach the server (is the backend running?)",
            true,
            timedOut ? "timeout" : "network"
        );
    }

    if (!response.ok) {
        const detail = await readErrorDetail(response);
        const retryable = response.status >= 500 || response.status === 429;
        throw makeError(`HTTP ${response.status} ${response.statusText}${detail}`, retryable, "http");
    }

    try {
        return await response.json();
    } catch {
        throw makeError("the server's response was not valid JSON", false, "parse");
    }
}

/** The backend sends { "error": "..." } on failure - use it if it is there. */
async function readErrorDetail(response) {
    try {
        const body = await response.json();
        if (body && typeof body.error === "string") return ` - ${body.error}`;
        if (body && typeof body.detail === "string") return ` - ${body.detail}`;
    } catch {
        // No body, or not JSON: the status line is enough.
    }
    return "";
}

function makeError(message, retryable, kind) {
    const error = new Error(message);
    error.retryable = retryable;
    error.kind = kind; // "network" | "timeout" | "http" | "parse"
    return error;
}

/** The one line telling the user what to actually do about it. */
function adviceFor(error) {
    switch (error.kind) {
        case "network":
        case "timeout":
            return `Check the backend is running and reachable at ${BASE_URL}.`;
        case "http":
            return error.retryable
                ? "The server is failing right now. This endpoint is expected to fail about 30% of the time, so loading again will probably work."
                : "The server rejected the request, so retrying is unlikely to help.";
        default:
            return "The server replied with something this page could not read.";
    }
}

// ---- Stretch: average price ----

async function fetchAveragePrice() {
    const payload = await getJson(`${BASE_URL}/medicines/average-price`);
    if (!payload || typeof payload.average_price !== "number") {
        throw new Error("The average-price response was not in the expected format.");
    }
    return payload;
}

// ---- Button wiring ----

/** Runs an action with consistent loading/error/busy handling. */
async function run(loadingMessage, action) {
    setBusy(true);
    // Clear first: a message left over from a previous click would otherwise
    // still be on screen, describing a failure that is not the current one.
    clearError();
    errorEl.classList.remove("warning");
    showLoading(loadingMessage);
    try {
        await action();
    } catch (error) {
        // An action that already wrote its own detailed message (fetchUnreliable)
        // leaves #error visible - don't overwrite it with something vaguer.
        if (errorEl.hidden) {
            showError([
                "Could not load the medicines.",
                `Reason: ${error.message}`,
                adviceFor(error),
            ]);
        }
    } finally {
        hideLoading();
        setBusy(false);
    }
}

document.getElementById("load-medicines").addEventListener("click", () =>
    run("Loading medicines...", async () => {
        const medicines = await fetchMedicines();
        renderMedicines(medicines);
        clearError();
    })
);

document.getElementById("load-unreliable").addEventListener("click", () =>
    // fetchUnreliable drives its own loading text per attempt.
    run("Loading from the unreliable source...", fetchUnreliable)
);

const averageButton = document.getElementById("load-average");
if (averageButton) {
    averageButton.addEventListener("click", () =>
        run("Working out the average price...", async () => {
            const { average_price, counted, skipped } = await fetchAveragePrice();
            clearError();
            setSummary(
                `Average price: ${formatPrice(average_price)} ` +
                `(from ${counted} medicines; ${skipped} skipped for a missing or invalid price).`
            );
        })
    );
}
