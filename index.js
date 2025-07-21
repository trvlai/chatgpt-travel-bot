const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const axios = require("axios");
const chrono = require("chrono-node");
const airports = require("iata-airports"); // <-- Make sure you `npm install iata-airports`
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store
const sessionStore = {};

// IATA city/airport lookup (Kiwi expects codes, not city names)
function cityToIATA(cityName) {
  if (!cityName) return null;
  // Try to find a "city" type code
  let match = airports.find(
    a => a.city && a.city.toLowerCase() === cityName.toLowerCase() && a.iata_type === "city"
  );
  if (match) return match.iata;
  // Fallback: try airport in city
  match = airports.find(
    a => a.city && a.city.toLowerCase() === cityName.toLowerCase()
  );
  if (match) return match.iata;
  // Fallback: accept exact code
  if (/^[A-Z]{3}$/.test(cityName.trim().toUpperCase())) return cityName.trim().toUpperCase();
  return null;
}

// Robust city/date extractor
function extractFlightInfo(text, sessionFlightSearch = {}) {
  let cityMatch = text.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s|$)/i);
  let from = cityMatch?.[1]?.trim() || null;
  let toRaw = cityMatch?.[2]?.trim() || null;
  let to = toRaw;
  if (to) to = to.replace(/\b(next|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b.*$/i, "").trim();

  let datePart = "";
  if (cityMatch) {
    datePart = text.slice(cityMatch[0].length);
    let matchDateWord = toRaw?.match(/\b(next|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b.*$/i);
    if (!datePart && matchDateWord) datePart = matchDateWord[0];
  } else {
    cityMatch = text.match(/to\s+([a-zA-Z\s]+)/i);
    to = cityMatch?.[1]?.trim() || to || null;
    from = sessionFlightSearch.from || from || null;
    datePart = cityMatch ? text.slice(cityMatch[0].length) : text;
    if (!to && !from) {
      const cityWord = text.match(/([A-Z][a-z]+)/g);
      if (cityWord && cityWord.length === 1) to = cityWord[0];
    }
  }
  const parsedDates = chrono.parse(datePart);
  const date = parsedDates.length ? parsedDates[0].start.date().toISOString().split("T")[0] : null;
  return { from, to, date };
}

app.get("/", (req, res) => {
  res.send("✅ Travel Chat API is running");
});

app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body;

  if (!prompt || !sessionId) {
    return res.status(400).json({ error: "Missing prompt or sessionId" });
  }

  // Init session
  if (!sessionStore[sessionId]) {
    sessionStore[sessionId] = {
      history: [
        {
          role: "system",
          content: `You're Moouris — a friendly, upbeat, and slightly playful AI travel assistant.
You love helping users find the best flights and trip options.
Ask only the information that’s missing (like destination, departure, date range, or trip duration),
and always keep your replies short, cheerful, and easy to read.
Avoid sounding robotic. Keep a helpful tone, like a smart and friendly concierge who's excited to assist!`
        }
      ],
      flightSearch: {
        from: null,
        to: null,
        date: null
      }
    };
  }

  const session = sessionStore[sessionId];
  session.history.push({ role: "user", content: prompt });

  // Extract info & accumulate
  const latestInfo = extractFlightInfo(prompt, session.flightSearch);
  if (latestInfo.from) session.flightSearch.from = latestInfo.from;
  if (latestInfo.to) session.flightSearch.to = latestInfo.to;
  if (latestInfo.date) session.flightSearch.date = latestInfo.date;
  const { from, to, date } = session.flightSearch;

  // Missing info?
  let missing = [];
  if (!from) missing.push("Which city will you be flying from?");
  if (!to) missing.push("Where would you like to fly to?");
  if (!date) missing.push("When would you like to fly?");
  if (missing.length) {
    const reply = "Just need a bit more info! " + missing.join(" ");
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  }

  // Use IATA codes!
  const fromIATA = cityToIATA(from);
  const toIATA = cityToIATA(to);
  if (!fromIATA || !toIATA) {
    const msg = `Sorry, I couldn't identify the airport codes for "${from}" or "${to}". Please try using major cities (e.g., "London" or "Dubai").`;
    session.history.push({ role: "assistant", content: msg });
    return res.json({ reply: msg });
  }

  console.log("[Kiwi flight search]", { fromIATA, toIATA, date });

  try {
    // Official Kiwi docs require source/destination as IATA code!
    const response = await axios.get("https://kiwi-com-cheap-flights.p.rapidapi.com/one-way", {
      params: {
        source: fromIATA,
        destination: toIATA,
        outbound: date,
        currency: "usd",
        locale: "en",
        adults: 1,
        cabinClass: "ECONOMY",
        sortBy: "QUALITY",
        limit: 3,
        contentProviders: "KIWI"
      },
      headers: {
        "X-RapidAPI-Key": process.env.KIWI_API_KEY,
        "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com"
      }
    });

    // Only log plain objects!
    console.log("[Kiwi API response]", JSON.stringify(response.data, null, 2));

    const flights = response.data?.data || [];
    if (!flights.length) {
      // Don't reset state on failure — let user refine query (only reset on success)
      return res.json({ reply: `😢 Sorry, I couldn't find any flights from ${from} to ${to} on ${date}.` });
    }

    const reply = flights.map(flight => {
      const airline = flight.airlines?.[0] || "Unknown airline";
      const price = flight.price?.amount || "N/A";
      const depTime = new Date(flight.local_departure).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `✈️ ${airline} — Departs at ${depTime}, $${price}`;
    }).join("\n");

    // Reset search on success
    session.flightSearch = { from: null, to: null, date: null };
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  } catch (err) {
    console.error("🔥 Kiwi API error:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "Flight search failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});

