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
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "48h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        highscore: user.highscore,
      },
    });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/signup", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await query("SELECT * FROM users WHERE email = $1", [email]);

    if (result.rows.length > 0) {
      return res.status(400).json({ message: "email already in use" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);

    const insert = await query(
      "INSERT INTO users (email, password, highscore) VALUES ($1, $2, $3) RETURNING id, email, highscore",
      [email, hashedPassword, 0]
    );

    const user = insert.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );
    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        highscore: user.highscore,
      },
    });
  } catch (error) {
    console.error("Error signing up:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
