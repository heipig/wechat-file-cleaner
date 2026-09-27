This directory holds files that must be shipped alongside the application, or that
the build reads at pack time.

It is currently empty on purpose. Deletion used to run a PowerShell script kept
here; that was replaced by Node's own `fs` for permanent deletion and a `.vbs`
generated at runtime for the Recycle Bin, because PowerShell availability,
execution policy, antivirus tolerance and the `Microsoft.VisualBasic` assembly all
vary between machines.

`tools/build-portable.mjs` tolerates this directory being empty. It packs it into
the archive when it has contents, so adding a file here is enough to ship it.
