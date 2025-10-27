import express from "express";
import dotenv from "dotenv";
import { query } from "../config/database.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

dotenv.config();

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await query("SELECT * FROM users WHERE email = $1", [email]);

    // Check if user exists
    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = result.rows[0];

    // Compare password with hashed password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Create JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "48h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        highscore: user.highscore,
      },
    });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/signup", async (req, res) => {
  const { email, password, username } = req.body;

  try {
    const result = await query("SELECT * FROM users WHERE email = $1", [email]);

    if (result.rows.length > 0) {
      return res.status(400).json({ message: "email already in use" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);

    const baseUsername = username?.trim() || email.split("@")[0] || "player";
    const sanitizedUsername =
      baseUsername.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) || "player";
    let uniqueUsername = sanitizedUsername;

    let attempts = 0;
    while (attempts < 3) {
      const usernameCheck = await query(
        "SELECT 1 FROM users WHERE username = $1",
        [uniqueUsername]
      );
      if (usernameCheck.rows.length === 0) break;
      attempts += 1;
      uniqueUsername = `${sanitizedUsername}${Math.floor(
        Math.random() * 1000
      )}`;
    }
    if (attempts === 3) {
      uniqueUsername = `${sanitizedUsername}-${Date.now()}`;
    }

    const insert = await query(
      "INSERT INTO users (email, username, password, highscore) VALUES ($1, $2, $3, $4) RETURNING id, email, username, highscore",
      [email, uniqueUsername, hashedPassword, 0]
    );

    const user = insert.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );
    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        highscore: user.highscore,
      },
    });
  } catch (error) {
    console.error("Error signing up:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
