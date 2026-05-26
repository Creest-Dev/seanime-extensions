// @ts-nocheck
class Provider {
  constructor() {
    this.api = "https://api.mangadex.org";
    this.uploadsBase = "https://uploads.mangadex.org";
    this.EXACT_MATCH_THRESHOLD = 0.85;
    this.FUZZY_MATCH_THRESHOLD = 0.65;
  }

  getSettings() {
    return {
      supportsMultiLanguage: true,
      supportsMultiScanlator: true
    };
  }

  async resolveAnilistId(anilistId) {
    try {
      var url = this.api + "/manga?includedExternalIds[]=" + anilistId + ":anilist&limit=10&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic";
      var res = await fetch(url);
      var json = await res.json();
      
      if (json.data && json.data.length > 0) {
        return json.data[0].id;
      }
      return null;
    } catch (e) {
      console.error("resolveAnilistId error:", e);
      return null;
    }
  }

  calculateSimilarity(a, b) {
    if (a === b) return 1.0;
    if (!a || !b) return 0.0;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) {
      var shorter = Math.min(a.length, b.length);
      var longer = Math.max(a.length, b.length);
      return shorter / longer;
    }
    var distance = this.levenshteinDistance(a, b);
    var maxLen = Math.max(a.length, b.length);
    return 1 - distance / maxLen;
  }

  levenshteinDistance(a, b) {
    var matrix = [];
    var i, j;
    for (i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    
    for (i = 1; i <= b.length; i++) {
      for (j = 1; j <= a.length; j++) {
        if (b.charAt(i-1) === a.charAt(j-1)) {
          matrix[i][j] = matrix[i-1][j-1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i-1][j-1] + 1,
            matrix[i][j-1] + 1,
            matrix[i-1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  async search(opts) {
    try {
      var query = opts.anilistTitle || opts.query;
      var url = this.api + "/manga?title=" + encodeURIComponent(query) + "&limit=20&order[relevance]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic";
      
      var res = await fetch(url);
      var json = await res.json();
      
      if (!json.data || json.data.length === 0) {
        return [];
      }

      var results = [];
      var targetTitle = query.toLowerCase().trim();

      for (var mi = 0; mi < json.data.length; mi++) {
        var manga = json.data[mi];
        var titleMap = manga.attributes.title;
        var altTitles = manga.attributes.altTitles || [];
        
        var allTitles = [];
        var keys = Object.keys(titleMap);
        for (var ki = 0; ki < keys.length; ki++) {
          allTitles.push(titleMap[keys[ki]]);
        }
        for (var ai = 0; ai < altTitles.length; ai++) {
          var altKeys = Object.keys(altTitles[ai]);
          for (var aki = 0; aki < altKeys.length; aki++) {
            allTitles.push(altTitles[ai][altKeys[aki]]);
          }
        }

        var bestScore = 0;
        for (var ti = 0; ti < allTitles.length; ti++) {
          var score = this.calculateSimilarity(targetTitle, allTitles[ti].toLowerCase().trim());
          if (score > bestScore) bestScore = score;
        }
        
        if (bestScore < this.FUZZY_MATCH_THRESHOLD) continue;

        var coverRel = null;
        for (var ri = 0; ri < manga.relationships.length; ri++) {
          if (manga.relationships[ri].type === "cover_art") {
            coverRel = manga.relationships[ri];
            break;
          }
        }
        var coverFileName = coverRel && coverRel.attributes ? coverRel.attributes.fileName : null;
        var coverUrl = coverFileName ? this.uploadsBase + "/covers/" + manga.id + "/" + coverFileName + ".256.jpg" : undefined;

        var synonyms = [];
        for (var si = 0; si < allTitles.length; si++) {
          if (allTitles[si].toLowerCase() !== targetTitle) {
            synonyms.push(allTitles[si]);
          }
        }

        var displayTitle = titleMap["en"] || titleMap["ja-ro"] || (keys.length > 0 ? titleMap[keys[0]] : "Unknown");

        results.push({
          id: manga.id,
          title: displayTitle,
          synonyms: synonyms,
          year: manga.attributes.year || undefined,
          image: coverUrl,
          _matchScore: bestScore
        });
      }

      results.sort(function(a, b) {
        return (b._matchScore || 0) - (a._matchScore || 0);
      });

      if (results.length > 0 && results[0]._matchScore >= this.EXACT_MATCH_THRESHOLD) {
        return [results[0]];
      }
      
      return results.slice(0, 5);
    } catch (e) {
      console.error("search error:", e);
      return [];
    }
  }

  async findChapters(mangaId) {
    var chapters = [];
    var offset = 0;
    var limit = 500;

    try {
      while (true) {
        var url = this.api + "/manga/" + mangaId + "/feed?limit=" + limit + "&offset=" + offset + "&order[chapter]=asc&includes[]=scanlation_group&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic";
        var res = await fetch(url);
        var json = await res.json();

        if (!json.data || json.data.length === 0) break;

        for (var ci = 0; ci < json.data.length; ci++) {
          var ch = json.data[ci];
          var attr = ch.attributes;
          if (attr.externalUrl) continue;

          var chapterNum = attr.chapter || "0";
          var vol = attr.volume ? "Vol." + attr.volume + " " : "";
          var titleSuffix = attr.title ? " - " + attr.title : "";
          var title = vol + "Ch." + this.padChapter(chapterNum) + titleSuffix;

          var scanlatorRel = null;
          for (var ri = 0; ri < ch.relationships.length; ri++) {
            if (ch.relationships[ri].type === "scanlation_group") {
              scanlatorRel = ch.relationships[ri];
              break;
            }
          }
          var scanlator = scanlatorRel && scanlatorRel.attributes ? scanlatorRel.attributes.name : undefined;

          chapters.push({
            id: ch.id,
            url: "https://mangadex.org/chapter/" + ch.id,
            title: title,
            chapter: chapterNum,
            index: 0,
            language: attr.translatedLanguage,
            scanlator: scanlator,
            updatedAt: attr.updatedAt
          });
        }

        if (offset + limit >= json.total) break;
        offset += limit;
      }
    } catch (e) {
      console.error("findChapters error:", e);
    }

    for (var ii = 0; ii < chapters.length; ii++) {
      chapters[ii].index = ii;
    }
    return chapters;
  }

  async findChapterPages(chapterId) {
    try {
      var res = await fetch(this.api + "/at-home/server/" + chapterId);
      var json = await res.json();
      var baseUrl = json.baseUrl;
      var chapter = json.chapter;
      var pages = [];

      for (var pi = 0; pi < chapter.data.length; pi++) {
        pages.push({
          url: baseUrl + "/data/" + chapter.hash + "/" + chapter.data[pi],
          index: pi,
          headers: { "Referer": "https://mangadex.org/" }
        });
      }
      return pages;
    } catch (e) {
      console.error("findChapterPages error:", e);
      return [];
    }
  }

  padChapter(chap) {
    var parts = chap.split(".");
    var intPart = parts[0];
    var rest = parts.slice(1);
    var padded = intPart.padStart(3, "0");
    return rest.length ? padded + "." + rest.join(".") : padded;
  }
}
