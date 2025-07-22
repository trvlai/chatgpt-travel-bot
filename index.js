const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const sessionStore = {};
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body;
  if (!prompt || !sessionId) {
    return res.status(400).json({ error: "Missing prompt or sessionId" });
  }

  // Initialize session
  if (!sessionStore[sessionId]) {
    sessionStore[sessionId] = {
      history: [
        {
          role: "system",
          content: `
You are Moouris, an upbeat, warm, and very human-sounding AI travel assistant. Your job is to help users book flights.
- If a user just says "hey" or "hi", greet them and ask how you can help (ONE time only).
- If they provide a request like "London to Dubai next Monday" (even with typos or weird word order), immediately extract as much as you can (origin, destination, date) and reply with a friendly, contextual response.
- If any info is missing, ask for just ONE missing piece at a time (never all at once), always in a conversational, friendly way.
- Never repeat the same greeting twice in a row or after the initial message.
- Once you have all info, ALWAYS reply with ONLY this sentence (no extra lines before or after):
"That sounds great! 😄 There is a direct flight from {FROM} to {TO} {DATE_TEXT} for $174💸. You can book your tickets [here](https://skyscanner.com)"
- Use the user’s actual cities and date, even if the date is vague ("next Monday", "early August", etc).
- DO NOT add anything after the booking link. Do not say "Safe travels!", do not sign off, do not say "let me know if you need more", etc. Only that line.
- Always sound like a real, helpful person, not a bot.
- Handle typos, abbreviations, and casual English.
`
        }
      ],
      flightSearch: { from: null, to: null, date: null },
      greeted: false
    };
  }

  const session = sessionStore[sessionId];
  session.history.push({ role: "user", content: prompt });

  // Call GPT for intent & slot extraction + reply
  const completion = await openai.chat.completions.create({
    model: "gpt-4o", // or "gpt-3.5-turbo"
    messages: [
      ...session.history,
      {
        role: "system",
        content: `
If the user message contains clear info, update (in your mind) the search: origin city, destination city, and date (even if the date is vague like "next Monday" or "in two weeks").
If something is missing, ask for it, but ONLY one thing at a time, in a friendly, real tone, and never repeat greetings after the first reply.
If you have all info, reply with ONLY this exact line, using the user’s input:
"That sounds great! 😄 There is a direct flight from {FROM} to {TO} {DATE_TEXT} for $174💸. You can book your tickets [here](https://skyscanner.com)"
DO NOT add anything after the booking link. Do not say "Safe travels!" or anything else.
If the user only says "hey" or "hi", greet and offer help just once.
`
      }
    ],
    temperature: 0.4,
    max_tokens: 220
  });

  // Keep conversation history short
  if (session.history.length > 20) session.history = session.history.slice(-10);

  // Save and reply
  const reply = completion.choices[0].message.content;
  session.history.push({ role: "assistant", content: reply });
  res.json({ reply });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});
