"""
FastAPI application for managing a list of medicines.

Endpoints:
- GET  /medicines             - all medicines (read from data.json)
- GET  /medicines/unreliable  - same data, but fails ~30% of the time
- GET  /medicines/average-price - mean price, ignoring unusable prices
- GET  /medicines/{name}      - a single medicine by name
- POST /create               - create a medicine (not part of the tasks)
- POST /update               - update a medicine's price (not part of the tasks)
- DELETE /delete             - delete a medicine (not part of the tasks)
"""
import json
import math
import random

from fastapi import FastAPI, Form, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

FAILURE_RATE = 0.3


def _load_medicines():
    with open("data.json") as meds:
        data = json.load(meds)
    return data["medicines"]


@app.get("/medicines")
def get_all_meds():
    return {"medicines": _load_medicines()}


@app.get("/medicines/unreliable")
def get_unreliable_meds(response: Response):
    if random.random() < FAILURE_RATE:
        response.status_code = 500
        return {"error": "The medicines service is temporarily unavailable."}
    return {"medicines": _load_medicines()}


def _as_price(raw):
    """Return raw as a float, or None if it is not a usable price.

    Covers the bad data in data.json: a missing key and an explicit null both
    arrive as None, and a price given as text ("6.99") is accepted because it
    is unambiguously a number. Anything else (a non-numeric string, a bool, a
    nested object) is ignored rather than guessed at.
    """
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if math.isfinite(raw) else None
    if isinstance(raw, str):
        try:
            value = float(raw.strip())
        except ValueError:
            return None
        return value if math.isfinite(value) else None
    return None


# Declared before /medicines/{name}: FastAPI matches routes in definition
# order, so the path-parameter route would otherwise capture "average-price".
@app.get("/medicines/average-price")
def get_average_price():
    """Average price across all medicines, ignoring unusable prices."""
    prices = []
    skipped = 0
    for med in _load_medicines():
        price = _as_price(med.get("price") if isinstance(med, dict) else None)
        if price is None:
            skipped += 1
        else:
            prices.append(price)

    average = round(sum(prices) / len(prices), 2) if prices else 0.0
    # counted/skipped are returned so the frontend can be honest about which
    # records the average is actually based on.
    return {"average_price": average, "counted": len(prices), "skipped": skipped}


@app.get("/medicines/{name}")
def get_single_med(name: str):
    for med in _load_medicines():
        if med.get("name") == name:
            return med
    return {"error": "Medicine not found"}


@app.post("/create")
def create_med(name: str = Form(...), price: float = Form(...)):
    with open("data.json", "r+") as meds:
        current_db = json.load(meds)
        new_med = {"name": name, "price": price}
        current_db["medicines"].append(new_med)
        meds.seek(0)
        json.dump(current_db, meds)
        meds.truncate()

    return {"message": f"Medicine created successfully with name: {name}"}


@app.post("/update")
def update_med(name: str = Form(...), price: float = Form(...)):
    with open("data.json", "r+") as meds:
        current_db = json.load(meds)
        for med in current_db["medicines"]:
            if med.get("name") == name:
                med["price"] = price
                meds.seek(0)
                json.dump(current_db, meds)
                meds.truncate()
                return {"message": f"Medicine updated successfully with name: {name}"}
    return {"error": "Medicine not found"}


@app.delete("/delete")
def delete_med(name: str = Form(...)):
    with open("data.json", "r+") as meds:
        current_db = json.load(meds)
        for med in current_db["medicines"]:
            if med.get("name") == name:
                current_db["medicines"].remove(med)
                meds.seek(0)
                json.dump(current_db, meds)
                meds.truncate()
                return {"message": f"Medicine deleted successfully with name: {name}"}
    return {"error": "Medicine not found"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
