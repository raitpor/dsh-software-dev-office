check:
	python3 docs/check.py

probe:
	python3 probe/run.py

design:
	python3 design/diagrams/build.py

design-check:
	python3 design/check.py

all: check probe design design-check

.PHONY: check probe design design-check all
