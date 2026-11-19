import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { revokeSession, SESSION_TTL_SECONDS, signInWithPassword } from "./service";
import { decodeSessionToken, encodeSessionToken } from "./session-token";

/**
 * Auth.js wiring: credentials provider, sessions stored in the database.
 *
 * Auth.js only accepts the credentials provider with strategy "jwt", so the cookie codec
 * is replaced (session-token.ts): the cookie carries the opaque token of a row in the
 * sessions table and every request is validated against that row. Revoking the row ends the
 * session at once. There is no signup: no adapter, no registration route, no create-user path.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: SESSION_TTL_SECONDS },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        // Only email and password are read from the client; the tenant is never an input.
        const r = await signInWithPassword(credentials?.email, credentials?.password);
        if (!r) return null;
        return { id: r.context.userId, email: r.context.email, sessionToken: r.sessionToken } as {
          id: string;
          email: string;
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      const t = (user as { sessionToken?: string } | undefined)?.sessionToken;
      if (t) token.sessionToken = t;
      return token;
    },
  },
  events: {
    async signOut(message) {
      const t = "token" in message ? message.token?.sessionToken : undefined;
      await revokeSession(t);
    },
  },
  jwt: { encode: encodeSessionToken, decode: decodeSessionToken },
});
