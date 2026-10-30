---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
'@substrat-run/model-emit': minor
---

A declared route (`defineRoutes`) can name `responseHeaders`. Its generated client method then answers `{ body, headers }`, and `headers` holds only the headers it names. A GET route's input field declared as an array is read by `mountRoutes` from every repeat of its query key, with each value coerced like the array's element. The generated client sends such a field once per value. A client whose routes declare neither gets the same output as before. Every generated client now answers a failed response whose body is not JSON (an HTML error page from a proxy, say) with an `ApiError` carrying its status, where it used to throw a `SyntaxError`.
