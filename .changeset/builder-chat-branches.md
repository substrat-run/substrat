---
'@substrat-run/builder': minor
'@substrat-run/builder-web': minor
---

The studio has chats: "New chat" starts a fresh conversation on a branch of its own, and earlier chats stay listed to resume. A chat's turns and editor saves commit to its branch, never to the project's base branch, so a release (which builds the base) and a GitHub deploy workflow watching it see a chat's work only once it is merged — by "Merge into main" for a studio project, which runs the checks first when the base has moved, or by a pull request on GitHub for a connected repository. A project's existing conversation becomes its first chat.
