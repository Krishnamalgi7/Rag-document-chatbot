/* =========================================================
   auth.js — SUPABASE AUTHENTICATION
   =========================================================
   PURPOSE:
     This file handles everything related to user login, signup,
     and logout using Supabase as the authentication provider.

   WHAT IS SUPABASE?
     Supabase is a "Backend as a Service" — it provides a
     ready-made authentication system so we don't have to
     build our own. It handles password hashing, sessions,
     email verification, JWT tokens, etc.

   WHAT IS A JWT TOKEN?
     JWT stands for JSON Web Token. After login, Supabase gives
     the user a "token" — a long encrypted string that proves
     who the user is. We send this token with every API request
     so the backend knows the user is authenticated.

   FUNCTIONS IN THIS FILE:
     1. initSupabase()           — Creates the Supabase client
     2. loginUser(email, pass)   — Signs in with email + password
     3. signupUser(email, pass)  — Creates a new account
     4. logoutUser()             — Signs out (does NOT delete docs)
     5. getCurrentSession()      — Gets the current auth session
     6. onAuthChange(callback)   — Listens for login/logout events

   INTERVIEW TIP:
     "Authentication uses Supabase's JS SDK. After login, I store
      the access token from the session and send it as a Bearer
      token in the Authorization header for protected API calls."
   ========================================================= */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// ── supabaseClient ────────────────────────────────────────
// This variable holds the Supabase client instance.
// It's created once (in initSupabase) and reused everywhere.
// We use "let" instead of "const" because it starts as null
// and gets assigned later.
let supabaseClient = null;


// ── initSupabase ──────────────────────────────────────────
//
// WHAT IT DOES:
//   Creates the Supabase client using our project's URL and
//   public anon key. The client is the object we use to call
//   all Supabase authentication functions.
//
// WHY INITIALIZE ONCE?
//   Creating a new Supabase client on every function call would
//   be wasteful. We create it once here and reuse it.
//
// HOW IT WORKS:
//   The Supabase JS library is loaded from CDN in chat.html as:
//     <script type="module"> import { createClient } from "..." </script>
//   But since we use it in our own modules, we access it via
//   the global window.supabase object that the CDN sets up.
//
// WHAT HAPPENS IF REMOVED:
//   No authentication would work. The app would always run in
//   "public mode" without user accounts.
//
export function initSupabase() {
  // window.supabase is set by the Supabase CDN script in chat.html
  // createClient() creates a configured client for our project
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabaseClient;
}


// ── getSupabaseClient ─────────────────────────────────────
//
// WHAT IT DOES:
//   Returns the already-created Supabase client.
//   Other files (modal.js) use this to get the client.
//
export function getSupabaseClient() {
  return supabaseClient;
}


// ── loginUser ─────────────────────────────────────────────
//
// WHAT IT DOES:
//   Takes an email and password, sends them to Supabase,
//   and returns the authenticated session if correct.
//
// HOW IT WORKS:
//   supabase.auth.signInWithPassword() sends a POST request to
//   Supabase's authentication server. If credentials are correct,
//   Supabase returns a session object containing:
//     - session.user        : User profile data (id, email, etc.)
//     - session.access_token: The JWT token for API requests
//
// PARAMETERS:
//   - email    : The user's email address
//   - password : The user's password (Supabase hashes it server-side)
//
// RETURNS:
//   { session, user } on success, or throws an error with a message.
//
// WHAT HAPPENS IF REMOVED:
//   Users cannot log in. The app is permanently in public mode.
//
export async function loginUser(email, password) {
  // signInWithPassword returns { data, error }
  // We destructure to get both
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email:    email.trim(),    // .trim() removes accidental spaces
    password: password,
  });

  // If Supabase returned an error, throw it so the caller can handle it
  if (error) {
    throw new Error(error.message);
  }

  // Return the session data for the caller to use
  return data;
}


// ── signupUser ────────────────────────────────────────────
//
// WHAT IT DOES:
//   Creates a new user account with Supabase using an email
//   and password. After signup, Supabase sends a confirmation
//   email. The user must click the link in that email before
//   they can log in.
//
// NOTE ON EMAIL CONFIRMATION:
//   Supabase requires email confirmation by default. After calling
//   signUp(), the user is NOT immediately logged in. They must
//   check their inbox, click the confirmation link, and then log in.
//
// PARAMETERS:
//   - email    : The desired email address
//   - password : The desired password
//
// RETURNS:
//   The data object from Supabase (user info)
//   Throws an error if signup fails (e.g., email already in use).
//
export async function signupUser(email, password) {
  const { data, error } = await supabaseClient.auth.signUp({
    email:    email.trim(),
    password: password,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}


// ── getCurrentSession ─────────────────────────────────────
//
// WHAT IT DOES:
//   Retrieves the current authentication session from Supabase.
//   If the user has logged in previously (and the session hasn't
//   expired), this returns their session data without requiring
//   them to log in again.
//
// WHY THIS IS IMPORTANT:
//   When the user refreshes the page, the JavaScript state
//   (React's useState, or our variables) is reset to null.
//   But Supabase stores the session in localStorage.
//   Calling getSession() on page load restores the user's
//   login state so they don't have to log in on every refresh.
//
// RETURNS:
//   { data: { session } } — session is null if not logged in,
//   or a session object if the user is authenticated.
//
export async function getCurrentSession() {
  const { data } = await supabaseClient.auth.getSession();
  return data.session; // Returns null if not logged in
}


// ── onAuthChange ──────────────────────────────────────────
//
// WHAT IT DOES:
//   Registers a "listener" (callback function) that Supabase
//   calls automatically whenever the auth state changes.
//   This means your callback is called when:
//     - The user logs in (event: "SIGNED_IN")
//     - The user logs out (event: "SIGNED_OUT")
//     - The session is refreshed (Supabase auto-refreshes tokens)
//
// WHY WE NEED THIS:
//   Without this listener, the UI would not update automatically
//   when the user's login state changes. For example, if the
//   session expires, we need to know so we can show the auth form.
//
// PARAMETERS:
//   - callback : A function that receives (event, session)
//                where session is null on logout, or the session object on login
//
// RETURNS:
//   A subscription object. Call subscription.unsubscribe() to
//   stop listening (important for cleanup).
//
// EXAMPLE USAGE:
//   onAuthChange((event, session) => {
//     if (session) {
//       showKBPanel(session.user);  // User is logged in
//     } else {
//       showAuthPanel();            // User is logged out
//     }
//   });
//
export function onAuthChange(callback) {
  // onAuthStateChange returns { data: { subscription } }
  const { data } = supabaseClient.auth.onAuthStateChange(callback);
  return data.subscription; // Return so the caller can unsubscribe
}


// ── signOutUser ───────────────────────────────────────────
//
// WHAT IT DOES:
//   Signs out the user from Supabase. This:
//     1. Invalidates their JWT token on Supabase's servers
//     2. Clears the session from localStorage
//     3. Triggers the onAuthChange listener with event "SIGNED_OUT"
//
// IMPORTANT:
//   This function does NOT clear the user's uploaded documents.
//   Document clearing is handled separately in modal.js (via api.js)
//   BEFORE calling this function, so documents are deleted first.
//
// WHAT HAPPENS IF REMOVED:
//   The user would stay logged in forever (until their token expires).
//   Their documents would never be deleted.
//
export async function signOutUser() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    console.error("[auth] Sign out error:", error.message);
  }
}
