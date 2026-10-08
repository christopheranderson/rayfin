import { describe, it, expect } from 'vitest';

import {
  claims,
  createItemProxy,
  item,
  FieldRef,
  ClaimRef,
  ComparisonExpression,
  serializeCheckToAst,
} from '../policy.js';
import type { ComparisonOperator } from '../policy.js';

interface Todo {
  id: string;
  user_id: string;
  isActive: boolean;
}

describe('Typed policy DSL', () => {
  it('serializes claim and item comparisons', () => {
    const todo = createItemProxy<Todo>();
    const expr = claims.sub.eq(todo.user_id);
    expect(expr.toString()).toBe('@claims.sub eq @item.user_id');

    const expr2 = claims.role.eq('admin').or(claims.sub.eq(todo.id));
    expect(expr2.toString()).toBe(
      "(@claims.role eq 'admin') or (@claims.sub eq @item.id)"
    );

    const expr3 = todo.isActive.neq(false).and(claims.email.eq('a@b.com'));
    expect(expr3.toString()).toBe(
      "(@item.isActive ne false) and (@claims.email eq 'a@b.com')"
    );
  });

  it('serializes string literals with escaping and dates', () => {
    const todo = createItemProxy<Todo>();
    const expr = todo.id.eq("O'Hare");
    expect(expr.toString()).toBe("@item.id eq 'O''Hare'");

    const date = new Date('2020-01-01T00:00:00.000Z');
    const expr2 = todo.id.eq(date);
    // DAB requires unquoted ISO-8601 UTC literals for date/datetime operands.
    expect(expr2.toString()).toBe('@item.id eq 2020-01-01T00:00:00.000Z');
  });

  it('exposes FieldRef and ClaimRef types for advanced usage', () => {
    const todo = createItemProxy<Todo>();
    const f: FieldRef = todo.id;
    const c: ClaimRef<'sub'> = claims.sub;
    expect(f.toString()).toBe('@item.id');
    expect(c.toString()).toBe('@claims.sub');
  });

  it('rejects unsupported operators instead of widening them to neq', () => {
    const expr = new ComparisonExpression(
      claims.sub,
      'gt' as ComparisonOperator,
      'user-id'
    );

    expect(() => serializeCheckToAst(expr)).toThrow(
      'Unsupported comparison operator for storage check AST: gt'
    );
  });

  describe('complex boolean expressions', () => {
    it('handles (A AND B) OR (C AND D) grouping', () => {
      const todo = createItemProxy<Todo>();
      const expr = claims.sub
        .eq(todo.user_id)
        .and(todo.isActive.eq(true))
        .or(claims.role.eq('admin').and(claims.email.eq('admin@example.com')));

      expect(expr.toString()).toBe(
        "((@claims.sub eq @item.user_id) and (@item.isActive eq true)) or ((@claims.role eq 'admin') and (@claims.email eq 'admin@example.com'))"
      );
    });

    it('handles (A OR B) AND (C OR D) grouping', () => {
      const todo = createItemProxy<Todo>();
      const expr = claims.sub
        .eq(todo.user_id)
        .or(claims.role.eq('admin'))
        .and(
          todo.isActive.eq(true).or(claims.email.eq('verified@example.com'))
        );

      expect(expr.toString()).toBe(
        "((@claims.sub eq @item.user_id) or (@claims.role eq 'admin')) and ((@item.isActive eq true) or (@claims.email eq 'verified@example.com'))"
      );
    });

    it('handles three-level nested expressions', () => {
      const todo = createItemProxy<Todo>();
      const expr = claims.sub
        .eq(todo.user_id)
        .and(todo.isActive.eq(true))
        .or(claims.role.eq('admin'))
        .and(claims.email.neq('blocked@example.com'));

      expect(expr.toString()).toBe(
        "(((@claims.sub eq @item.user_id) and (@item.isActive eq true)) or (@claims.role eq 'admin')) and (@claims.email ne 'blocked@example.com')"
      );
    });

    it('handles multiple ORs chained together', () => {
      const todo = createItemProxy<Todo>();
      const expr = claims.role
        .eq('admin')
        .or(claims.role.eq('moderator'))
        .or(claims.role.eq('editor'))
        .or(claims.sub.eq(todo.user_id));

      expect(expr.toString()).toBe(
        "(((@claims.role eq 'admin') or (@claims.role eq 'moderator')) or (@claims.role eq 'editor')) or (@claims.sub eq @item.user_id)"
      );
    });

    it('handles multiple ANDs chained together', () => {
      const todo = createItemProxy<Todo>();
      const expr = claims.sub
        .eq(todo.user_id)
        .and(todo.isActive.eq(true))
        .and(claims.email.neq(''))
        .and(claims.role.eq('user'));

      expect(expr.toString()).toBe(
        "(((@claims.sub eq @item.user_id) and (@item.isActive eq true)) and (@claims.email ne '')) and (@claims.role eq 'user')"
      );
    });

    it('handles deep nesting with mixed operators', () => {
      const todo = createItemProxy<Todo>();
      // ((owner OR admin) AND active) OR (public AND verified)
      const expr = claims.sub
        .eq(todo.user_id)
        .or(claims.role.eq('admin'))
        .and(todo.isActive.eq(true))
        .or(todo.id.eq('public').and(claims.email.neq('')));

      expect(expr.toString()).toBe(
        "(((@claims.sub eq @item.user_id) or (@claims.role eq 'admin')) and (@item.isActive eq true)) or ((@item.id eq 'public') and (@claims.email ne ''))"
      );
    });

    it('preserves string escaping in complex expressions', () => {
      const todo = createItemProxy<Todo>();
      const expr = claims.email
        .eq("O'Brien@example.com")
        .and(todo.id.eq("user's-todo"))
        .or(claims.role.eq("admin's-role"));

      expect(expr.toString()).toBe(
        "((@claims.email eq 'O''Brien@example.com') and (@item.id eq 'user''s-todo')) or (@claims.role eq 'admin''s-role')"
      );
    });

    it('handles null comparisons in complex expressions', () => {
      const todo = createItemProxy<Todo>();
      const expr = todo.user_id
        .neq(null)
        .and(claims.sub.eq(todo.user_id))
        .or(claims.role.eq('admin').and(todo.isActive.eq(true)));

      expect(expr.toString()).toBe(
        "((@item.user_id ne null) and (@claims.sub eq @item.user_id)) or ((@claims.role eq 'admin') and (@item.isActive eq true))"
      );
    });
  });
});
