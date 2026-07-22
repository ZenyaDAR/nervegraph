import os

from .models import User
from . import VERSION


def index():
    return f"{os.name} {VERSION} {User}"
