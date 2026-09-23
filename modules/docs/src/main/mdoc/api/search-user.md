---
layout: docs
title: "Search User"
section: "api"
---

# Search User

Searches for a user whose username matches the given pattern. The pattern supports a single leading
or trailing wildcard (`*` or `%`) to perform a partial/contains match; a pattern with wildcards on
both ends is not supported. Returns the first matching user's details, including the groups they
belong to.

#### HTTP REQUEST

> GET /users/search/{pattern}

#### EXAMPLE HTTP REQUEST

```http
GET /users/search/ok
```

#### HTTP RESPONSE TYPES

| Code | description                                                                                                                                                                                |
|------|:-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 200  | **OK** - The matched user is returned in the response body                                                                                                                                 |
| 401  | **Unauthorized** - The authentication information provided is invalid.  Typically the request was not signed properly, or the access key and secret used to sign the request are incorrect |
| 404  | **Not Found** - No user matching the pattern was found                                                                                                                                     |

#### HTTP RESPONSE ATTRIBUTES

| name     | type   | description              |
|----------|--------|:-------------------------|
| id       | string | Unique UUID of the user  |
| userName | string | The username of the user |
| groupId  | Array of groupId's | The Group ID's of the user |
| groupMap | Object mapping groupId to group name | The Group ID's of the user mapped to their group names |


#### EXAMPLE RESPONSE

```json
{
  "id": "ok",
  "userName": "ok",
  "groupId" : [
    "ok-group"
  ],
  "groupMap": {
    "ok-group": "ok-group-name"
  }
}
```

#### EXAMPLE ERROR RESPONSE
```text
User matching doesntexistuser was not found
```
