const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ API Key Check
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing!");
} else {
  console.log("✅ OPENAI_API_KEY loaded successfully");
}

// ✅ Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Health Check Route
app.get("/", (req, res) => {
  res.send("✅ Travel Chat API is running");
});

// ✅ Chat Endpoint
app.post("/chat", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [
        {
          role: "system",
          content:
            "You are a concise and practical AI travel assistant. Respond clearly and briefly. Avoid repeating general travel facts unless asked."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.5,      // Balanced creativity
      max_tokens: 500        // Limit response length
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("🔥 Error during OpenAI call:", err?.response?.data || err.message || err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Server Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Travel bot API running on port ${PORT}`);
});
