Status: draft v0.1 · Last updated: <date> · For review before any code

# <The name of the thing you are building>

This is the readable description of the app, for the people who own it. Three sections are
written by `substrat concept sync` from the code (entity model and processes from `model.json`;
roles from a `PERMISSIONS.md` beside it, when there is one) and the rest by hand. Do not edit
between the `substrat:` markers: the next sync overwrites it, and `substrat concept sync --check`
exits 1 while one is stale.

## 1. Purpose and users

_Authored. Who this is for, what it does, in their words._

## 2. Roles and permissions

<!-- substrat:roles -->
<!-- /substrat:roles -->

## 3. Entity model

<!-- substrat:entities -->
<!-- /substrat:entities -->

## 4. Processes

<!-- substrat:processes -->
<!-- /substrat:processes -->

## 5. Screens and dashboard

_Authored. What each person sees first, and what the dashboard answers._

## 6. Decisions log

_Authored, appended on every change to the model or to a permission: the date, what changed, and why._

## 7. Open questions

_Authored. What is not decided yet, and who decides it._
