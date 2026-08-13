# PaperPort — ICICI Breeze API TOTP Setup Guide

## Overview

PaperPort uses the ICICI Breeze API to fetch live market data (quotes, historical charts, options chain) for paper trading. Breeze requires a **session token** that expires every 24 hours. PaperPort can auto-generate this token daily using your **TOTP secret**, so you only set it up once.

---

## Prerequisites

| Item | Where to get it |
|------|----------------|
| ICICI Direct Trading Account | [icicidirect.com](https://www.icicidirect.com) |
| Breeze API App (API Key + Secret Key) | [api.icicidirect.com](https://api.icicidirect.com) |
| TOTP enabled on your ICICI account | ICICI Direct Security Settings |
| TOTP Secret (Base32 key) | Shown during TOTP setup (see Step 2 below) |

---

## Step 1 — Create a Breeze API App

1. Go to [api.icicidirect.com](https://api.icicidirect.com)
2. Log in with your ICICI Direct credentials
3. Navigate to **Apps** → **Create New App**
4. Fill in:
   - **App Name**: `PaperPort` (any name)
   - **Redirect URL**: `https://paper-port.onrender.com/api/auth/breeze-callback`
     - For local development use: `http://localhost:8000/api/auth/breeze-callback`
5. After creation, note down:
   - **API Key** (a long alphanumeric string)
   - **Secret Key** (shown once — copy and save it securely)

> **Important**: The Redirect URL in your Breeze App settings MUST match where PaperPort is hosted. If it doesn't match, the session popup flow won't work.

---

## Step 2 — Get Your TOTP Secret Key

The TOTP secret is the **Base32 key** used to generate 6-digit time-based codes. This is the same key you entered into Google Authenticator or Authy when setting up 2FA for ICICI Direct.

### If you saved it during initial TOTP setup:

- It looks like: `GUZ1ASKWSB1M1ZVX3PMSSJHA` (uppercase letters and numbers, 16-32 characters)
- Use this value directly

### If you don't have it saved — Reset TOTP:

1. Log in to [icicidirect.com](https://www.icicidirect.com)
2. Go to **Profile** → **Security Settings** → **Two-Factor Authentication**
3. Click **Reset TOTP** or **Regenerate**
4. When the QR code appears, look for:
   - **"Can't scan QR code?"** link, OR
   - **"View Secret Key"** / **"Manual Entry"** option
5. **Copy and securely save the Base32 secret key** — this is your TOTP Secret
6. Scan the QR code with your authenticator app (Google Authenticator / Authy) as usual

> **Warning**: After resetting TOTP, your old authenticator app entry will stop working. You must re-scan the new QR code.

---

## Step 3 — Enter Credentials in PaperPort

1. Open PaperPort and navigate to **Settings** (left sidebar)
2. Scroll to the **Breeze API Credentials** section

### First-time setup (all 5 fields required):

| Field | Value | Example |
|-------|-------|---------|
| API Key | Your Breeze API Key | `43Xk29!bH7...` |
| Secret Key | Your Breeze Secret Key | `Mn92@pL5z...` |
| ICICI Login ID | Your ICICI Direct User ID | `nagender4512` |
| ICICI Login Password | Your ICICI Direct password or PIN | `••••••` |
| TOTP Secret | Base32 key from Step 2 | `GUZ1ASKWSB1M1ZVX3PMSSJHA` |

3. Click **"Update Credentials"**
4. You should see: _"Credentials saved! Auto-login is enabled"_

### Updating only login credentials (API already connected):

If your API Key and Secret Key are already saved, you only need to fill in:
- ICICI Login ID
- ICICI Login Password
- TOTP Secret

Leave the API Key and Secret Key fields empty — the existing values are preserved.

---

## Step 4 — Generate a Session Token

You have **three options**, in order of preference:

### Option A: Auto Generate (Preferred)

1. Click the green **"Auto Generate Session"** button
2. PaperPort will:
   - Generate a fresh TOTP code from your secret
   - Simulate the ICICI login flow
   - Capture and save the session token
3. If successful: _"Session generated automatically"_

### Option B: Session Popup (Fallback)

If auto-generate fails (e.g., ICICI blocks server-side requests):

1. Click **"Generate Session Popup"**
2. A popup window opens with ICICI's login page
3. Log in with your credentials and enter the TOTP from your authenticator app
4. After login, the popup auto-closes and the session token is captured
5. You should see: _"Session token captured and saved from popup"_

> **Note**: Allow popups in your browser for the PaperPort site.

### Option C: Manual Paste (Last resort)

1. Log in to ICICI Direct / Breeze manually
2. Copy the session token from the redirect URL (the `apisession` parameter)
3. Paste it into the **"Session Token"** field in Settings
4. Click **"Save Session"**

---

## Step 5 — Verify Connection

After saving a session token (via any method), verify:

| Status | What it means |
|--------|--------------|
| ✅ API Connected | API Key and Secret Key are saved |
| ✅ Session Active | Valid session token — live data works |
| ✅ Auto-Login Enabled | Login ID + Password + TOTP are saved |
| ⏰ Session Expiry | Shows when the current session expires |

Go to the **Trading Terminal** and search for a stock (e.g., `RELIANCE`). If you see live price data, the connection is working.

---

## How Auto-Renewal Works

Once all credentials are saved, PaperPort handles session renewal automatically:

```
┌─────────────────────────────────────────────────────────┐
│                   Daily Auto-Renewal                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  8:00 AM IST (Mon–Sat)                                  │
│  └─> Server generates TOTP from saved secret            │
│      └─> Simulates ICICI login flow                     │
│          └─> Captures new session token                 │
│              └─> Saves to database                      │
│                                                          │
│  8:30 AM IST (Mon–Sat)                                  │
│  └─> Retry if 8:00 AM attempt failed                   │
│                                                          │
│  On Server Restart                                       │
│  └─> Auto-generates session 15 seconds after boot       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

- Sessions are valid for **24 hours**
- Renewal happens **before market open** (9:15 AM IST)
- If auto-renewal fails, you'll see the error in Settings and can use the popup fallback

---

## Security

All sensitive credentials are encrypted at rest:

| Data | Encryption |
|------|-----------|
| API Key | AES-256-CBC |
| Secret Key | AES-256-CBC |
| Login ID | AES-256-CBC |
| Login Password | AES-256-CBC |
| TOTP Secret | AES-256-CBC |
| Session Token | AES-256-CBC |

- Encryption key is stored as an environment variable on the server
- Credentials are never exposed in API responses
- The TOTP secret is only used server-side to generate 6-digit codes

---

## Troubleshooting

### "Auto session failed. Browser flow: Login ID or Password not provided"

**Cause**: Login credentials were not saved to the database.

**Fix**: Go to Settings, fill in Login ID, Password, and TOTP Secret, then click **"Update Credentials"** before clicking "Auto Generate Session".

### "Auto session failed. Browser flow: TOTP submitted but no session returned"

**Cause**: ICICI rejected the TOTP code or changed their login page structure.

**Fix**:
1. Verify your TOTP secret generates valid codes (compare with your authenticator app)
2. Try the **"Generate Session Popup"** fallback
3. If the popup works, auto-login may need a code update for ICICI's latest login flow

### "Auto session failed. Direct API: No session token in response"

**Cause**: The direct API method didn't return a session. This is normal for most accounts.

**Fix**: This is a secondary fallback. If browser flow also failed, use the popup method.

### "Popup blocked by browser"

**Cause**: Browser is blocking the popup window.

**Fix**: Allow popups for the PaperPort site in your browser settings.

### Session expires mid-day

**Cause**: Session tokens are valid for 24 hours from generation. If generated late, they expire during trading hours.

**Fix**: Ensure auto-renewal runs at 8:00 AM. If you generated manually, do it before 9:15 AM.

### "No Session — enter session token below"

**Cause**: No valid session token exists (expired or never generated).

**Fix**: Click "Auto Generate Session" or use the popup/manual method.

---

## Quick Reference

| Action | How |
|--------|-----|
| First-time setup | Fill all 5 fields → Update Credentials → Auto Generate Session |
| Daily (automatic) | Nothing — server auto-renews at 8:00 AM |
| Daily (manual fallback) | Click "Auto Generate Session" or "Generate Session Popup" |
| Check status | Settings page → look at status indicators |
| Update TOTP secret | Fill TOTP Secret field → Update Credentials |
| Change password/PIN | Fill Login Password field → Update Credentials |

---

*Document version: 1.0 | Last updated: March 2026 | PaperPort — Paper Trading Platform*
