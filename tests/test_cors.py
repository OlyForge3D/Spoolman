"""Unit tests for CORS configuration in env.py."""

import os
from unittest import mock

import pytest

from spoolman import env

# get_cors_origin tests


def test_cors_origin_returns_none_when_not_set():
    with mock.patch.dict(os.environ, {}, clear=True):
        assert env.get_cors_origin() is None


def test_cors_origin_single():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ORIGIN": "http://example.com"}):
        assert env.get_cors_origin() == ["http://example.com"]


def test_cors_origin_multiple():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ORIGIN": "http://a.com,http://b.com"}):
        assert env.get_cors_origin() == ["http://a.com", "http://b.com"]


def test_cors_origin_strips_whitespace():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ORIGIN": "http://a.com , http://b.com"}):
        assert env.get_cors_origin() == ["http://a.com", "http://b.com"]


def test_cors_origin_wildcard():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ORIGIN": "*"}):
        assert env.get_cors_origin() == ["*"]


# is_cors_defined tests


def test_cors_defined_false_when_not_set():
    with mock.patch.dict(os.environ, {}, clear=True):
        assert env.is_cors_defined() is False


def test_cors_defined_false_when_set_to_false():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ORIGIN": "FALSE"}):
        assert env.is_cors_defined() is False


def test_cors_defined_false_when_set_to_zero():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ORIGIN": "0"}):
        assert env.is_cors_defined() is False


def test_cors_defined_true_when_set_to_origin():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ORIGIN": "http://example.com"}):
        assert env.is_cors_defined() is True


def test_cors_defined_true_when_set_to_wildcard():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ORIGIN": "*"}):
        assert env.is_cors_defined() is True


# get_cors_allow_methods tests


def test_cors_allow_methods_default():
    with mock.patch.dict(os.environ, {}, clear=True):
        assert env.get_cors_allow_methods() == ["*"]


def test_cors_allow_methods_custom():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ALLOW_METHODS": "GET, POST, PUT"}):
        assert env.get_cors_allow_methods() == ["GET", "POST", "PUT"]


def test_cors_allow_methods_strips_whitespace():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ALLOW_METHODS": " GET , POST "}):
        assert env.get_cors_allow_methods() == ["GET", "POST"]


# get_cors_allow_headers tests


def test_cors_allow_headers_default():
    with mock.patch.dict(os.environ, {}, clear=True):
        assert env.get_cors_allow_headers() == ["*"]


def test_cors_allow_headers_custom():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ALLOW_HEADERS": "Content-Type, Authorization"}):
        assert env.get_cors_allow_headers() == ["Content-Type", "Authorization"]


# get_cors_expose_headers tests


def test_cors_expose_headers_default():
    with mock.patch.dict(os.environ, {}, clear=True):
        assert env.get_cors_expose_headers() == ["X-Total-Count"]


def test_cors_expose_headers_custom():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_EXPOSE_HEADERS": "X-Total-Count, X-Custom"}):
        assert env.get_cors_expose_headers() == ["X-Total-Count", "X-Custom"]


# get_cors_allow_credentials tests


def test_cors_allow_credentials_default_true():
    with mock.patch.dict(os.environ, {}, clear=True):
        assert env.get_cors_allow_credentials() is True


def test_cors_allow_credentials_false():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ALLOW_CREDENTIALS": "FALSE"}):
        assert env.get_cors_allow_credentials() is False


def test_cors_allow_credentials_zero():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ALLOW_CREDENTIALS": "0"}):
        assert env.get_cors_allow_credentials() is False


def test_cors_allow_credentials_true():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ALLOW_CREDENTIALS": "TRUE"}):
        assert env.get_cors_allow_credentials() is True


def test_cors_allow_credentials_one():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ALLOW_CREDENTIALS": "1"}):
        assert env.get_cors_allow_credentials() is True


def test_cors_allow_credentials_invalid_raises():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_ALLOW_CREDENTIALS": "INVALID"}), pytest.raises(
        ValueError, match="SPOOLMAN_CORS_ALLOW_CREDENTIALS"
    ):
        env.get_cors_allow_credentials()


# get_cors_max_age tests


def test_cors_max_age_default():
    with mock.patch.dict(os.environ, {}, clear=True):
        assert env.get_cors_max_age() == 600


def test_cors_max_age_custom():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_MAX_AGE": "3600"}):
        assert env.get_cors_max_age() == 3600


def test_cors_max_age_invalid_raises():
    with mock.patch.dict(os.environ, {"SPOOLMAN_CORS_MAX_AGE": "not_a_number"}), pytest.raises(
        ValueError, match="SPOOLMAN_CORS_MAX_AGE"
    ):
        env.get_cors_max_age()
