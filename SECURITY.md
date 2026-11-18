# Security

## Supported versions

Only the [latest release](https://github.com/Sheldonmayhew/notaboek/releases/latest) gets security fixes. Check the problem is still there in it before reporting.

## Reporting a problem

Don't open a public issue. [Report it privately](https://github.com/Sheldonmayhew/notaboek/security/advisories/new) instead, from the **Security** tab under **Report a vulnerability**. Only you and the maintainer can see the report.

Include:

- the version and Windows version you used
- what an attacker could do, and what they'd need first (a file you open, a link you click)
- the steps to show it, or a file that does, with anything private taken out

Replies come in the same report. When a fix is released, the advisory is published and you're credited, unless you'd rather not be named.

## What counts

Anything in this repository: the desktop app, its installer, and the readers and writers for Markdown, text, CSV, TaskPaper, PDF and Word files. A file that can run code, read other files, reach the network or hang the app when it's opened is in scope.

Problems in Electron, Chromium or another dependency belong with that project, but a report here is still welcome if Notaboek is affected.
