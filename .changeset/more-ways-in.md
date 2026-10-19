---
"cuttingfloor": minor
---

More ways to get a file in. `media.import` takes a small file as a `data:` URI (up to 8 MB, refused if it doesn't match the `sha256` given), and a file the user attached in the chat as `file` (`{download_url, file_id, mime_type, file_name}`, declared in `openai/fileParams` so ChatGPT passes attachments). Dropbox and Google Drive share links import as they are. A `media.upload` link opened in a browser is a page to drop the file on; it sends in parts and resumes on its own.
