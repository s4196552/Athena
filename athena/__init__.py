"""Athena -- a local, read-only data manager.

The one rule the whole design hangs from: Athena reads user files and never
writes to them. Every other decision here follows from it.
"""

__version__ = "0.1.0"
