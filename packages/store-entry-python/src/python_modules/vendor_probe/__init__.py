"""A vendored pure-Python dependency for the store-entry probe (#2390)."""

from importlib.resources import files


def label():
    return "vendor-probe"


def payload():
    return files("vendor_probe").joinpath("payload.txt").read_text(encoding="utf-8").strip()
