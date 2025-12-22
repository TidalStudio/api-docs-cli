Look up API documentation for: $ARGUMENTS

## Your Task

Fetch and display API endpoint documentation based on the user's input.

## Workflow

1. **Parse the input** (`$ARGUMENTS`):
   - If it looks like a URL (contains `://` or starts with `http`), treat it as an OpenAPI spec URL
   - Otherwise, treat it as an APIs.guru provider name (e.g., "stripe", "github", "twilio")

2. **Fetch the endpoints**:

   ```bash
   api-docs endpoints <query>
   ```

3. **Format the response**:
   - Show the API title and version
   - Summarize endpoint count
   - List endpoints grouped by resource path
   - Highlight key operations (CRUD, auth, etc.)

4. **Handle errors gracefully**:
   - If the spec can't be fetched, suggest alternatives
   - Recommend checking the URL or trying a different provider name

## Examples

**User runs:** `/api-docs stripe`

- Execute: `api-docs endpoints stripe`
- Return formatted endpoint list

**User runs:** `/api-docs https://petstore.swagger.io/v2/swagger.json`

- Execute: `api-docs endpoints https://petstore.swagger.io/v2/swagger.json`
- Return formatted endpoint list

**User runs:** `/api-docs github`

- Execute: `api-docs endpoints github`
- Return formatted endpoint list for GitHub API
