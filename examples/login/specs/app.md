# Example login app

`/login` (also `/`) shows a form with a Username field, a Password field, and a "Sign in" button (renamed from "Log in" in the latest release). Submitting valid credentials sets a session cookie and redirects to `/home`, whose heading greets the user by name. Submitting invalid credentials re-renders the form with an alert that says "Invalid credentials".

`/home` requires the session; without it the app redirects to `/login`. It shows the greeting and a "Log out" link, which clears the session and returns to `/login`.

The only account is `alice`; her password is the secret `ALICE_PASSWORD`.
