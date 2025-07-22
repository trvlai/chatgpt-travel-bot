const express = require("express");
const cors = require("cors");
const chrono = require("chrono-node");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const sessionStore = {};

function shouldGreet(session) {
  return session.history.length === 1; // Only system message
}

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

  // --- All info gathered: show link ---
  const reply = `That sounds great! 😄 You can book your tickets here:\nskyscanner.com`;
  // Reset state for a new search after this reply
  session.flightSearch = { from: null, to: null, date: null };
  session.history.push({ role: "assistant", content: reply });
  return res.json({ reply });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});
