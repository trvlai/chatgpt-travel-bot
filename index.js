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

// Helper: Only greet if this is the very first exchange
function shouldGreet(session) {
  return session.history.length === 1; // Only the system prompt exists
}

// Extract flight info robustly: "London to Dubai next Monday", "from Paris to Rome", etc.
function extractFlightInfo(text, sessionFlightSearch = {}) {
  let cityMatch = text.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s|$)/i);
  let from = cityMatch?.[1]?.trim() || null;
  let to = cityMatch?.[2]?.trim() || null;

  // Handles "London to Dubai next Monday" or "London → Dubai"
  if (!from || !to) {
    let genericMatch = text.match(/([A-Z][a-zA-Z\s]+)\s+(?:to|–|->)\s+([A-Z][a-zA-Z\s]+)/i);
    if (genericMatch) {
      from = genericMatch[1].trim();
      to = genericMatch[2].trim();
    }
  }

  // Fill from session if needed
  from = from || sessionFlightSearch.from || null;
  to = to || sessionFlightSearch.to || null;

  // Date extraction—everything after both cities
  let afterCities = text;
  if (to) {
    afterCities = text.split(to).slice(1).join(" ");
  }
  const parsedDates = chrono.parse(afterCities);
  const date = parsedDates.length ? parsedDates[0].start.date().toISOString().split("T")[0] : (sessionFlightSearch.date || null);

  return { from, to, date };
}

// City name -> Skyscanner code
const cityToSkyId = city => {
  const lookup = {
    london: "LOND",
    paris: "PARI",
    rome: "ROME",
    dubai: "DXBA",
    newyork: "NYCA",
    madrid: "MADR",
    barcelona: "BCN",
    tokyo: "TYOA"
    // ...expand as needed!
  };
  if (!city) return null;
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

  // Init session (with system prompt)
  if (!sessionStore[sessionId]) {
    sessionStore[sessionId] = {
      history: [
        {
          role: "system",
          content: `You're Moouris, a warm, friendly, and enthusiastic AI travel buddy! Your goal is to help users find the best flights with a conversational, human-like tone. Be empathetic, upbeat, and clear, like a trusted friend who's excited to plan a trip. Understand natural phrases like "London to Dubai next Monday" and gently guide users to provide missing details (e.g., departure city, destination, or date) one at a time—never all together, and never greet twice. Keep replies short, engaging, and easy to follow, with a touch of charm!`
        }
      ],
      flightSearch: { from: null, to: null, date: null }
    };
  }

  const session = sessionStore[sessionId];
  session.history.push({ role: "user", content: prompt });

  // --- Robust info extraction/accumulation ---
  const latestInfo = extractFlightInfo(prompt, session.flightSearch);
  if (latestInfo.from) session.flightSearch.from = latestInfo.from;
  if (latestInfo.to) session.flightSearch.to = latestInfo.to;
  if (latestInfo.date) session.flightSearch.date = latestInfo.date;
  const { from, to, date } = session.flightSearch;

  // --- Friendly, step-by-step missing info ---
  let missing = [];
  if (!from) missing.push("from");
  if (!to) missing.push("to");
  if (!date) missing.push("date");

  // Pick *one* missing info to ask for (never all together)
  if (missing.length) {
    let reply = "";
    if (shouldGreet(session)) {
      reply = `Hey there! I'm excited to help with your trip.`;
    }
    if (!from) {
      reply += (reply ? " " : "") + "Which city are you flying from?";
    } else if (!to) {
      reply += (reply ? " " : "") + "Great! Where would you like to fly to?";
    } else if (!date) {
      reply += (reply ? " " : "") + `Awesome! When would you like to travel from ${from} to ${to}?`;
    }
    reply = reply.trim() + " 😊";
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  }

  // --- City to Skyscanner code ---
  const fromSkyId = cityToSkyId(from);
  const toSkyId = cityToSkyId(to);

  if (!fromSkyId || !toSkyId) {
    const msg = `Oops, I had trouble finding "${from}" or "${to}". Could you try major cities like London, Paris, or Dubai? 😊`;
    session.history.push({ role: "assistant", content: msg });
    return res.json({ reply: msg });
  }

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
      const reply = `Oh no, I couldn't find any flights from ${from} to ${to} on ${date}. Want to try another date or destination? 😊`;
      session.history.push({ role: "assistant", content: reply });
      return res.json({ reply });
    }

    // Friendly summary with top 3 flights
    const reply = `Great news! Here are some flight options from ${from} to ${to} on ${date}:\n` + 
      itineraries.slice(0, 3).map(flight => {
        const price = flight.price?.raw || "N/A";
        const dep = flight.legs?.[0]?.departureTime || "";
        const arr = flight.legs?.[0]?.arrivalTime || "";
        return `✈️ $${price} | Departs: ${dep} → Arrives: ${arr}`;
      }).join("\n") + `\nLet me know if you want more details or different options! 😄`;

    // Reset after successful search
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
