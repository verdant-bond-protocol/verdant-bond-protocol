# API errors

HTTP failures are normalized by `apiErrorInterceptor` into an `AppError` with
`status`, `title`, and `detail`. Components should use `appErrorMessage(error,
fallback)` in subscription error handlers when they need an operation-specific
fallback. Do not read `error.error` directly; this keeps RFC 7807, validation,
contract, and authentication responses consistent across the UI.