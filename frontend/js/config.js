/* =========================================================
   config.js — APPLICATION CONFIGURATION
   =========================================================
   PURPOSE:
     This file holds all the "settings" that might need to
     change between environments (development, production).
     Instead of scattering these values across many files,
     we define them once here and import them where needed.

   WHY SEPARATE FROM OTHER FILES?
     If you deploy to production, you only need to change
     values in this one file — not hunt through 7 JS files.

   INTERVIEW TIP:
     "I used a config file to centralize environment-specific
      values. This follows the separation of concerns principle."
   ========================================================= */

// ── Supabase Configuration ────────────────────────────────
// Supabase is the backend-as-a-service we use for authentication.
// These two values identify YOUR Supabase project.
//
// SUPABASE_URL: The base URL of your Supabase project.
//               Every API call to Supabase goes to this URL.
//
// SUPABASE_ANON_KEY: A PUBLIC key (safe to put in frontend code).
//               It identifies your app to Supabase, but does NOT
//               grant admin access. Think of it like an "app ID".
//
// WHERE TO FIND THESE:
//   Supabase Dashboard → Project Settings → API → Project URL & anon key
export const SUPABASE_URL     = "https://nfvrcqmxcykshuilojed.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_S62ygCJBy-uhMr3rYYAdzQ_63L9u5K_";

// ── Backend API Configuration ─────────────────────────────
// This is the URL where your FastAPI backend is running.
//
// In development: http://127.0.0.1:8000 (localhost)
// In production:  replace with your deployed server URL
//                 e.g., "https://api.yourapp.com"
//
// WHY NOT HARDCODE THIS IN api.js?
//   Because if we deploy, we only change it HERE,
//   not in every file that makes API calls.
export const API_BASE = "http://127.0.0.1:8000";
