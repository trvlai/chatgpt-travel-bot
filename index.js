const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ In-memory session store (replace with Redis/DB for production)
const sessionStore = {};

// Load API Key
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing!");
} else {
  console.log("✅ OPENAI_API_KEY loaded");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/", (req, res) => {
  res.send("✅ Travel Chat API is running");
});

app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body;

  if (!prompt || !sessionId) {
    return res.status(400).json({ error: "Missing prompt or sessionId" });
  }

  // Create session if it doesn't exist
  if (!sessionStore[sessionId]) {
    sessionStore[sessionId] = {
      history: [
        {
          role: "system",
          content: "You're Moouris — a friendly, upbeat, and slightly playful AI travel assistant. 
You love helping users find the best flights and trip options. 
Ask only the information that’s missing (like destination, departure, date range, or trip duration), 
and always keep your replies short, cheerful, and easy to read. 
Avoid sounding robotic. Keep a helpful tone, like a smart and friendly concierge who's excited to assist!"
        }
      ]
    };
  }

  const session = sessionStore[sessionId];
  session.history.push({ role: "user", content: prompt });

  // Optional: limit history for token budget
  const recentMessages = session.history.slice(-10);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: recentMessages,
      temperature: 0.4,
      max_tokens: 300
    });

    const reply = completion.choices[0].message.content;
    session.history.push({ role: "assistant", content: reply });

    res.json({ reply });
  } catch (err) {
    console.error("🔥 OpenAI error:", err?.response?.data || err.message || err);
    res.status(500).json({ error: "AI request failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});
