const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const axios = require("axios");
const chrono = require("chrono-node");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store
const sessionStore = {};

// --- Helper: More robust city/date extraction ---
function extractFlightInfo(text, sessionFlightSearch = {}) {
  let cityRegex = /([A-Z][a-zA-Z\s]+)\s+(?:to|–|->)\s+([A-Z][a-zA-Z\s]+)(?:\s+|$)/i;
  let cityMatch = text.match(cityRegex);
  let from = cityMatch?.[1]?.trim() || null;
  let to = cityMatch?.[2]?.trim() || null;

  // fallback for “from X to Y” or just “X to Y”
  if (!from || !to) {
    let fromMatch = text.match(/from\s+([a-zA-Z\s]+)/i);
    let toMatch = text.match(/to\s+([a-zA-Z\s]+)/i);
    if (fromMatch && toMatch) {
      from = fromMatch[1].trim();
      to = toMatch[1].trim();
    } else if (toMatch) {
      to = toMatch[1].trim();
      from = sessionFlightSearch.from || null;
    }
  }

  // parse the first date mention after cities
  let datePart = text;
  if (to) {
    datePart = text.split(to).slice(1).join(" ");
  }
  let parsedDates = chrono.parse(datePart);
  let date = parsedDates.length ? parsedDates[0].start.date().toISOString().split("T")[0] : null;

  return { from, to, date };
}

// Skyscanner city code lookup (expand as needed)
const cityToSkyId = city => {
  if (!city) return null;
  const lookup = {
    london: "LOND",
    paris: "PARI",
    rome: "ROME",
    dubai: "DXBA",
    newyork: "NYCA",
    madrid: "MADR",
    barcelona: "BCN",
    tokyo: "TYOA",
    athens: "ATH",
    berlin: "BERL",
    istanbul: "ISTA"
    // ...add more for production!
  };
  return lookup[city.toLowerCase().replace(/\s/g, "")] || null;
};

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
          content: `You're Moouris — a warm, fun, upbeat AI travel buddy! You love helping users find flights and trips.
Always ask for missing info, but keep replies casual, friendly, and excited (like a smart travel friend, not a robot).
If you’re missing info (like destination, departure, date, or trip duration), just ask for what’s missing and keep it short and positive!`
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

  // Try to extract info from this prompt
  const latestInfo = extractFlightInfo(prompt, session.flightSearch);
  if (latestInfo.from) session.flightSearch.from = latestInfo.from;
  if (latestInfo.to) session.flightSearch.to = latestInfo.to;
  if (latestInfo.date) session.flightSearch.date = latestInfo.date;
  const { from, to, date } = session.flightSearch;

  // Friendly missing info handler
  let missing = [];
  if (!from) missing.push("Where are you flying from?");
  if (!to) missing.push("Where do you want to go?");
  if (!date) missing.push("When do you want to fly?");
  if (missing.length) {
    const reply = "✈️ Almost ready! " + missing.join(" ");
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  }

  // City name to SkyId code
  const fromSkyId = cityToSkyId(from);
  const toSkyId = cityToSkyId(to);

  if (!fromSkyId || !toSkyId) {
    const msg = `🙈 Oops! I couldn't match "${from}" or "${to}" to a city code. Try big cities like London, Paris, Rome, or Dubai.`;
    session.history.push({ role: "assistant", content: msg });
    return res.json({ reply: msg });
  }

  // Friendly log
  console.log("[Fly Scraper flight search]", { fromSkyId, toSkyId, date });

  try {
    const response = await axios.get("https://fly-scraper.p.rapidapi.com/flights/search-one-way", {
      params: {
        originSkyId: fromSkyId,
        destinationSkyId: toSkyId,
        departureDate: date,
        adults: "1"
      },
      headers: {
        "x-rapidapi-key": process.env.RAPIDAPI_KEY,
        "x-rapidapi-host": "fly-scraper.p.rapidapi.com"
      }
    });

    const itineraries = response.data?.data?.itineraries || [];
    if (!itineraries.length) {
      return res.json({ reply: `😬 No flights found from ${from} to ${to} on ${date}. Want to try a different day or city?` });
    }

    // Friendly flight results
    const reply = itineraries.slice(0, 3).map(flight => {
      const price = flight.price?.raw || "N/A";
      const dep = flight.legs?.[0]?.departureTime || "";
      const arr = flight.legs?.[0]?.arrivalTime || "";
      return `🎫 $${price} | Departure: ${dep} → Arrival: ${arr}`;
    }).join("\n");

    // Reset search fields after a successful result!
    session.flightSearch = { from: null, to: null, date: null };
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  } catch (err) {
    console.error("🔥 Fly Scraper API error:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "Flight search failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});
