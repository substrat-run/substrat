---
"@substrat-run/demo-ticket0": patch
---

A customer writing into a conversation the desk has closed is answered instead of refused. `closed` stays terminal — it is the escape hatch out of the inbox, and a thread anyone could climb back into by writing one more line would not be one — so the message opens a follow-up conversation for the same contact, with `conversation.follows` naming the thread it continues. A widget session moves to the follow-up carrying the same token, so the visitor's chat bubble keeps working; an inbound email does the same. Before this, both paths returned `invalid transition: conversation … is 'closed'`, which reached a visitor of substrat.net verbatim.

The widget also stops rendering server error text at visitors: the status decides a plain sentence and the real error goes to the browser console, where the person debugging an embed is.
