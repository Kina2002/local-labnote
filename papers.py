"""Literature providers. Requests take approved search terms or public paper IDs."""

import html
import json
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor


CROSSREF = "https://api.crossref.org/works"
SEMANTIC_SCHOLAR = "https://api.semanticscholar.org/graph/v1/paper"
USER_AGENT = "LocalLabnote/0.1 (research notebook)"
CROSSREF_FIELDS = (
    "DOI,title,author,published,URL,container-title,abstract,update-to,is-referenced-by-count"
)
GRAPH_FIELDS = "title,authors,year,venue,publicationTypes,externalIds,citationCount,abstract,url,openAccessPdf"
GRAPH_DIRECTIONS = {"references": "citedPaper", "citations": "citingPaper"}
TERM_PATTERN = re.compile(r"[^\W_][\w-]*", re.UNICODE)
STOP_WORDS = {
    "a", "an", "and", "are", "at", "by", "for", "how", "in", "is", "of", "on",
    "or", "paper", "papers", "research", "study", "the", "to", "what", "with",
}
QUERY_VOCABULARY = (
    ("자가복원", "self-healing"), ("자가치유", "self-healing"),
    ("스스로 회복", "self-healing"), ("폴리우레탄", "polyurethane"),
    ("수계", "waterborne"), ("코팅", "coating"), ("상온", "room temperature"),
    ("흠집", "scratch"), ("이황화", "disulfide"), ("투명", "transparent"),
    ("투과율", "transmittance"), ("접착력", "adhesion"), ("인장 강도", "tensile strength"),
    ("고분자", "polymer"), ("표면처리", "surface treatment"), ("내구성", "durability"),
)
SEARCH_SYNONYMS = {
    "self-healing": "scratch recovery", "waterborne": "water-based",
    "adhesion": "bond strength", "transmittance": "optical transmission",
    "room temperature": "ambient temperature",
}


def normalize_doi(value):
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if re.match(r"https?://(?:dx\.)?doi\.org/", value, re.I):
        value = urllib.parse.unquote(urllib.parse.urlsplit(value).path.lstrip("/"))
    else:
        value = re.sub(r"^doi:\s*", "", value, flags=re.I)
    if len(value) <= 250 and re.fullmatch(r"10\.\d{4,9}/[^\s\x00-\x1f\x7f]+", value, re.I):
        return value.lower()
    return ""


def public_paper_id(value):
    if not isinstance(value, str):
        return ""
    if re.fullmatch(r"[a-fA-F0-9]{40}", value):
        return value.lower()
    doi = normalize_doi(value)
    return f"DOI:{doi}" if doi else ""


def safe_url(value):
    if not isinstance(value, str):
        return ""
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme in {"http", "https"} and parsed.hostname and parsed.username is None:
            return value
    except ValueError:
        pass
    return ""


def text(value):
    if not isinstance(value, str):
        return ""
    return " ".join(html.unescape(re.sub(r"<[^>]*>", " ", value)).split())


def first_text(values):
    return text(values[0]) if isinstance(values, list) and values else ""


def paper_kind(title, abstract, types=()):
    if "Review" in types or "MetaAnalysis" in types or re.search(
        r"\b(?:systematic review|a review|meta.analysis|scoping review)\b", title, re.I
    ):
        return "review"
    if re.search(r"\b(?:methods?|experimental)\b", abstract, re.I) and re.search(r"\bresults?\b", abstract, re.I):
        return "likely_original"
    return "unknown"


def crossref_paper(item):
    doi = normalize_doi(item.get("DOI"))
    title = first_text(item.get("title"))
    abstract = text(item.get("abstract"))
    authors = []
    for author in item.get("author") or []:
        name = text(author.get("name")) or " ".join(
            part for part in (text(author.get("given")), text(author.get("family"))) if part
        )
        if name:
            authors.append(name)
    date_parts = (item.get("published") or {}).get("date-parts") or [[]]
    year = date_parts[0][0] if date_parts[0] else None
    updates = []
    for update in item.get("update-to") or []:
        target = normalize_doi(update.get("DOI"))
        kind = update.get("type")
        if target and kind in {"retraction", "correction", "erratum", "corrigendum"}:
            updates.append({"doi": target, "kind": "retraction" if kind == "retraction" else "correction"})
    return {
        "doi": doi, "title": title, "authors": authors, "year": year,
        "journal": first_text(item.get("container-title")),
        "url": doi_url(doi) if doi else safe_url(item.get("URL")),
        "abstract": abstract[:6500], "kind": paper_kind(title, abstract),
        "citation_count": item.get("is-referenced-by-count"), "updates": updates,
        "update_status": "notice" if updates else "unknown",
    }


def doi_url(doi):
    return "https://doi.org/" + urllib.parse.quote(doi, safe="/")


def graph_paper(item):
    doi = normalize_doi((item.get("externalIds") or {}).get("DOI"))
    identifier = item.get("paperId")
    paper_id = identifier.lower() if isinstance(identifier, str) and re.fullmatch(r"[a-fA-F0-9]{40}", identifier) else ""
    title = text(item.get("title"))
    abstract = text(item.get("abstract"))
    return {
        "doi": doi, "paper_id": paper_id, "title": title,
        "authors": [name for author in item.get("authors") or [] if (name := text(author.get("name")))],
        "year": item.get("year"), "journal": text(item.get("venue")),
        "url": doi_url(doi) if doi else safe_url(item.get("url")),
        "abstract": abstract[:6500], "kind": paper_kind(title, abstract, item.get("publicationTypes") or []),
        "citation_count": item.get("citationCount"),
        "open_url": safe_url((item.get("openAccessPdf") or {}).get("url")),
        "update_status": "unknown",
    }


def terms(value):
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return set(TERM_PATTERN.findall(normalized)) - STOP_WORDS


def matched_terms(paper, query):
    title = terms(paper["title"])
    abstract = terms(paper["abstract"])
    active = terms(query)
    return {"title": sorted(active & title), "abstract": sorted(active & (abstract - title))}


def plain_key(value):
    return "".join(ch for ch in unicodedata.normalize("NFKC", value).casefold() if ch.isalnum())


def alternate_key(paper):
    if paper["title"] and paper["authors"] and paper["year"]:
        return (plain_key(paper["title"]), plain_key(paper["authors"][0]), paper["year"])
    return None


def find_duplicate(results, paper):
    if paper["doi"]:
        match = next((other for other in results if other["doi"] == paper["doi"]), None)
        if match is not None:
            return match
    key = alternate_key(paper)
    if key is not None:
        matches = [other for other in results if (not paper["doi"] or not other["doi"]) and alternate_key(other) == key]
        if len(matches) == 1:
            return matches[0]
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get_json(url, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=12) as response:
        return json.load(response)


def provider_error(error):
    if isinstance(error, urllib.error.HTTPError):
        error.close()
        if error.code == 429:
            return "요청이 많아 조회가 제한되었습니다. 잠시 뒤 다시 시도해 주세요."
        if error.code == 404:
            return "등록된 논문이나 인용 정보를 찾지 못했습니다."
        if error.code in {401, 403}:
            return "검색 서비스에서 조회를 허용하지 않았습니다."
    return "검색 서비스에 연결하지 못했습니다."


def search_one(query):
    params = urllib.parse.urlencode({"query.bibliographic": query, "rows": 8, "select": CROSSREF_FIELDS})
    attempt = {"provider": "Crossref", "query": query, "status": "ok"}
    try:
        items = get_json(f"{CROSSREF}?{params}")["message"]["items"]
        papers = [paper for item in items if (paper := crossref_paper(item))["title"]]
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        return [], {**attempt, "status": "error", "error": provider_error(error)}
    return papers, {**attempt, "count": len(papers)}


def approved_queries(payload):
    queries = payload.get("queries")
    if not isinstance(queries, list) or not 1 <= len(queries) <= 3:
        raise ValueError("보낼 검색어를 1~3개 선택해 주세요.")
    if any(not isinstance(query, str) or query != query.strip() or not 3 <= len(query) <= 250
           or re.search(r"[\x00-\x1f\x7f]", query) for query in queries):
        raise ValueError("검색어를 3~250자의 한 줄로 입력해 주세요.")
    return list(dict.fromkeys(queries))


def clean_suggestions(values):
    if not isinstance(values, list):
        return []
    cleaned = []
    for value in values:
        if not isinstance(value, str):
            continue
        value = " ".join(value.split())
        if 3 <= len(value) <= 250 and value not in cleaned:
            cleaned.append(value)
    return cleaned[:3]


def basic_suggestions(question):
    if re.search(r"[가-힣]", question):
        concepts = list(dict.fromkeys(english for korean, english in QUERY_VOCABULARY if korean in question))
    else:
        concepts = list(dict.fromkeys(
            token for token in TERM_PATTERN.findall(question.casefold()) if token not in STOP_WORDS
        ))
    if len(concepts) < 2:
        return []
    full = " ".join(concepts)
    broad = " ".join(concepts[:-1]) if len(concepts) > 2 else ""
    alternate = full
    for term, synonym in SEARCH_SYNONYMS.items():
        alternate = re.sub(rf"(?<![\w-]){re.escape(term)}(?![\w-])", synonym, alternate)
    return clean_suggestions([broad, full, alternate])


def search_papers(queries):
    with ThreadPoolExecutor(max_workers=len(queries)) as executor:
        responses = list(executor.map(search_one, queries))
    results = []
    notices = {}
    for query, (papers, _) in zip(queries, responses):
        for paper in papers:
            for update in paper["updates"]:
                if update["kind"] == "retraction" or update["doi"] not in notices:
                    notices[update["doi"]] = update["kind"]
            matches = matched_terms(paper, query)
            origin = {"provider": "Crossref", "query": query, "matches": matches}
            other = find_duplicate(results, paper)
            if other is None:
                paper["origins"] = [origin]
                results.append(paper)
            else:
                for field in ("doi", "url", "authors", "journal", "year", "abstract"):
                    if not other[field]:
                        other[field] = paper[field]
                if paper["update_status"] == "notice":
                    other["update_status"] = "notice"
                if paper["kind"] == "review" or other["kind"] == "unknown":
                    other["kind"] = paper["kind"]
                if not any(previous["query"] == query for previous in other["origins"]):
                    other["origins"].append(origin)
    for paper in results:
        paper.pop("updates")
        paper["update_status"] = notices.get(paper["doi"], paper["update_status"])

    def rank(paper):
        return max(
            2 * len(origin["matches"]["title"]) + len(origin["matches"]["abstract"])
            for origin in paper["origins"]
        )

    if len(queries) > 1:
        results.sort(key=rank, reverse=True)
    return {"papers": results, "attempts": [attempt for _, attempt in responses]}


def follow_paper(identifier, direction, key=""):
    if not identifier or public_paper_id(identifier) != identifier or not isinstance(direction, str) or direction not in GRAPH_DIRECTIONS:
        raise ValueError("조회할 공개 DOI 또는 논문 ID를 확인해 주세요.")
    params = urllib.parse.urlencode({"fields": GRAPH_FIELDS, "limit": 10})
    resource = urllib.parse.quote(identifier, safe=":")
    attempt = {"provider": "Semantic Scholar", "identifier": identifier, "direction": direction, "status": "ok"}
    try:
        data = get_json(
            f"{SEMANTIC_SCHOLAR}/{resource}/{direction}?{params}",
            {"x-api-key": key} if key else None,
        )["data"]
        # The references endpoint can return data: null for an indexed paper
        # with no available references.
        if data is None:
            data = []
        papers = []
        for link in data:
            item = link.get(GRAPH_DIRECTIONS[direction])
            if item and (paper := graph_paper(item))["title"]:
                paper["origins"] = [attempt.copy()]
                papers.append(paper)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        return {"papers": [], "attempts": [{**attempt, "status": "error", "error": provider_error(error)}]}
    return {"papers": papers, "attempts": [{**attempt, "count": len(papers)}]}
