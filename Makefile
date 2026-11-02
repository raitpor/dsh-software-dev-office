check:
	python3 docs/check.py

probe:
	python3 probe/run.py

design:
	python3 design/diagrams/build.py

all: check probe design

.PHONY: check probe design all
