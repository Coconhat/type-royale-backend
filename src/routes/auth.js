import express from "express";
import dotenv from "dotenv";
import { query } from "../config/database.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Resend } from "resend";

dotenv.config();

const router = express.Router();

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;
const VERIFICATION_TTL_HOURS = Number(
  process.env.EMAIL_VERIFICATION_TTL_HOURS || 24
);

// Builds and sends a verification email via Resend; degrades gracefully if misconfigured.
const sendVerificationEmail = async ({ email, username, token }) => {
  if (!resend) {
    console.warn(
      "Resend client not configured; skipping verification email send."
    );
    return;
  }

  if (!process.env.RESEND_FROM_EMAIL) {
    console.warn("RESEND_FROM_EMAIL not set; cannot send verification email.");
    return;
  }

  if (!process.env.EMAIL_VERIFICATION_URL) {
    console.warn(
      "EMAIL_VERIFICATION_URL not set; cannot build verification link."
    );
    return;
  }

  let verificationUrl;

  try {
    const url = new URL(process.env.EMAIL_VERIFICATION_URL);
    url.searchParams.set("token", token);
    verificationUrl = url.toString();
  } catch (error) {
    console.error(
      "Invalid EMAIL_VERIFICATION_URL; cannot send verification email.",
      error
    );
    return;
  }

  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: "Verify your Type Royale account",
      html: `
        <p>Hi ${username || "there"},</p>
        <p>Welcome to Type Royale! Please verify your email address to activate your account.</p>
        <p><a href="${verificationUrl}">Click here to verify your email</a>.</p>
        <p>If you did not create this account, you can ignore this message.</p>
      `,
    });
  } catch (error) {
    console.error("Failed to send verification email via Resend", error);
  }
};

const createVerificationToken = () => {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000
  );
  return { token, expiresAt };
};

const normaliseEmail = (value) => value?.trim().toLowerCase();

router.post("/login", async (req, res) => {
  const { password } = req.body;
  const email = normaliseEmail(req.body.email);

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

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

    if (user.is_verified === false) {
      return res.status(403).json({
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email before logging in.",
      });
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
  const { password, username } = req.body;
  const email = normaliseEmail(req.body.email);

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

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

    const { token: verificationToken, expiresAt: verificationExpires } =
      createVerificationToken();

    const insert = await query(
      `
        INSERT INTO users (
          email,
          username,
          password,
          highscore,
          is_verified,
          verification_token,
          verification_token_expires
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, email, username, highscore, is_verified
      `,
      [
        email,
        uniqueUsername,
        hashedPassword,
        0,
        false,
        verificationToken,
        verificationExpires,
      ]
    );

    const user = insert.rows[0];

    await sendVerificationEmail({
      email,
      username: user.username,
      token: verificationToken,
    });

    res.status(201).json({
      message: "Account created. Check your email for a verification link.",
      requiresVerification: user.is_verified === false,
    });
  } catch (error) {
    console.error("Error signing up:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/verify-email", async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ message: "Verification token is required" });
  }

  try {
    const result = await query(
      `
        SELECT id, email, username, highscore, verification_token_expires
        FROM users
        WHERE verification_token = $1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res
        .status(400)
        .json({ message: "Invalid or expired verification token" });
    }

    const user = result.rows[0];
    const expiresAt = user.verification_token_expires
      ? new Date(user.verification_token_expires)
      : null;

    if (expiresAt && expiresAt.getTime() < Date.now()) {
      return res
        .status(400)
        .json({ message: "Verification token has expired" });
    }

    const update = await query(
      `
        UPDATE users
        SET is_verified = TRUE,
            verification_token = NULL,
            verification_token_expires = NULL
        WHERE id = $1
        RETURNING id, email, username, highscore
      `,
      [user.id]
    );

    const verifiedUser = update.rows[0];

    const jwtToken = jwt.sign(
      {
        id: verifiedUser.id,
        email: verifiedUser.email,
        username: verifiedUser.username,
      },
      process.env.JWT_SECRET,
      { expiresIn: "48h" }
    );

    res.json({
      message: "Email verified successfully",
      token: jwtToken,
      user: {
        id: verifiedUser.id,
        email: verifiedUser.email,
        username: verifiedUser.username,
        highscore: verifiedUser.highscore,
      },
    });
  } catch (error) {
    console.error("Error verifying email:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/resend-verification", async (req, res) => {
  const email = normaliseEmail(req.body.email);

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const result = await query(
      `
        SELECT id, username, is_verified
        FROM users
        WHERE email = $1
      `,
      [email]
    );

    if (result.rows.length === 0) {
      return res.json({
        message:
          "If that account exists, a verification email will arrive shortly.",
      });
    }

    const user = result.rows[0];

    if (user.is_verified) {
      return res.json({ message: "This account is already verified." });
    }

    const { token: verificationToken, expiresAt: verificationExpires } =
      createVerificationToken();

    await query(
      `
        UPDATE users
        SET verification_token = $1,
            verification_token_expires = $2
        WHERE id = $3
      `,
      [verificationToken, verificationExpires, user.id]
    );

    await sendVerificationEmail({
      email,
      username: user.username,
      token: verificationToken,
    });

    res.json({ message: "Verification email resent." });
  } catch (error) {
    console.error("Error resending verification email:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
