---
tags: [smoke]
---
# Login

## Scenario: valid credentials
Steps:
- Open the login page
- Enter username `alice` and password {{env.ALICE_PASSWORD}}
- Click "Sign in"

Expect:
- The heading "Welcome, alice" is visible

## Scenario: wrong password
Steps:
- Open the login page
- Enter username `alice` and password `wrong`
- Click "Sign in"

Expect:
- An alert with the text "Invalid credentials" is visible
- The login form is still shown
