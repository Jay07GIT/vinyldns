from hamcrest import *


def test_search_users_success(shared_zone_test_context):
    """
    Tests that searching for a user by an exact username returns that user's details
    """
    client = shared_zone_test_context.ok_vinyldns_client
    ok_group = shared_zone_test_context.ok_group

    result = client.search_users("ok", status=200)

    assert_that(result["id"], is_("ok"))
    assert_that(result["userName"], is_("ok"))
    assert_that(result["groupId"], has_item(ok_group["id"]))
    assert_that(result["groupMap"], has_key(ok_group["id"]))
    assert_that(result["groupMap"][ok_group["id"]], is_(ok_group["name"]))


def test_search_users_partial_match_trailing_wildcard(shared_zone_test_context):
    """
    Tests that searching for a user by a trailing wildcard username match (wildcard/contains behavior) succeeds
    """
    client = shared_zone_test_context.ok_vinyldns_client

    result = client.search_users("ok*", status=200)

    assert_that(result["id"], is_("ok"))
    assert_that(result["userName"], is_("ok"))


def test_search_users_partial_match_leading_wildcard(shared_zone_test_context):
    """
    Tests that searching for a user by a leading wildcard username match (wildcard/contains behavior) succeeds
    """
    client = shared_zone_test_context.ok_vinyldns_client

    result = client.search_users("*ok", status=200)

    assert_that(result["id"], is_("ok"))
    assert_that(result["userName"], is_("ok"))


def test_search_users_both_sided_wildcard_not_found(shared_zone_test_context):
    """
    Documents a current backend limitation: searchUsersByName only strips a wildcard from one
    side of the pattern (leading OR trailing, not both), so a pattern with wildcards on both
    ends leaves a literal '*' in the LIKE pattern and will not match any username.
    """
    client = shared_zone_test_context.ok_vinyldns_client

    client.search_users("*ok*", status=404)


def test_search_users_not_found(shared_zone_test_context):
    """
    Tests that searching for a user whose username does not match any user returns a 404
    """
    client = shared_zone_test_context.ok_vinyldns_client

    client.search_users("doesntexistuser", status=404)
